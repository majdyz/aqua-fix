// Translation-only video stabilizer.
//
// Pipeline:
//   1. Play the source video with playbackRate=2 (muted) and capture each
//      decoded frame via requestVideoFrameCallback. Falls back to rAF when
//      rVFC is unavailable.
//   2. Downsample each frame to a tiny grayscale thumbnail.
//   3. For consecutive thumbnails, find the integer (dx, dy) shift that
//      minimises sum-of-absolute-differences over their overlap, search
//      window +/- MAX_SHIFT.
//   4. Refine to sub-pixel using parabolic interpolation on the 3 SAD samples
//      around the integer minimum, separately along x and y.
//   5. Scale up by source/thumb ratio and accumulate to get the camera path.
//
// Smoothing is applied separately at render time so the slider can change
// without re-running analysis.
//
// We deliberately avoid jsfeat / OpenCV.js to keep the bundle tiny.

const THUMB_W = 128;
const THUMB_H = 72;
const MAX_SHIFT = 16;

export type AnalysisResult = {
  cumX: Float32Array;
  cumY: Float32Array;
  frameCount: number;
  frameRate: number;
};

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number;
};

export async function analyzeVideo(
  video: HTMLVideoElement,
  onProgress: (p: number) => void,
): Promise<AnalysisResult> {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video has no usable duration");
  }
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) throw new Error("Video has no usable size");

  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = THUMB_H;
  const thumbCtx = thumbCanvas.getContext("2d", { willReadFrequently: true });
  if (!thumbCtx) throw new Error("2D canvas unavailable");
  thumbCtx.imageSmoothingEnabled = true;
  thumbCtx.imageSmoothingQuality = "medium";

  // Make sure the decoder has at least one frame ready before we kick play().
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => {
      const onReady = () => {
        video.removeEventListener("canplay", onReady);
        resolve();
      };
      video.addEventListener("canplay", onReady);
      setTimeout(resolve, 6000);
    });
  }

  const wasPaused = video.paused;
  const resumeAt = video.currentTime;
  const wasMuted = video.muted;
  const wasLoop = video.loop;
  const wasRate = video.playbackRate;

  video.muted = true; // muted autoplay is allowed everywhere
  video.loop = false;
  // 2x is the widely supported speed-up; iOS Safari is reliable up to here.
  // The actual frame rate the encoder produces is unchanged.
  try {
    video.playbackRate = 2;
  } catch {
    // some browsers cap it silently — that's fine
  }

  if (video.currentTime > 0.05) {
    await seekToStart(video);
  }

  const scaleX = srcW / THUMB_W;
  const scaleY = srcH / THUMB_H;

  const thumbsX: number[] = [0];
  const thumbsY: number[] = [0];
  let cumX = 0;
  let cumY = 0;
  let prevThumb: Uint8Array | null = null;

  const v = video as VideoWithRVFC;

  return new Promise<AnalysisResult>((resolve, reject) => {
    let finished = false;
    let lastWatchdogTime = 0;
    let watchdog: number | null = null;

    const restore = () => {
      try {
        video.pause();
      } catch {
        // ignore
      }
      video.muted = wasMuted;
      video.loop = wasLoop;
      try {
        video.playbackRate = wasRate;
      } catch {
        // ignore
      }
      try {
        video.currentTime = resumeAt;
      } catch {
        // ignore
      }
      if (!wasPaused) video.play().catch(() => undefined);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      if (watchdog !== null) clearInterval(watchdog);
      restore();
      onProgress(1);
      resolve({
        cumX: Float32Array.from(thumbsX),
        cumY: Float32Array.from(thumbsY),
        frameCount: thumbsX.length,
        frameRate: 30,
      });
    };

    const fail = (err: Error) => {
      if (finished) return;
      finished = true;
      if (watchdog !== null) clearInterval(watchdog);
      restore();
      reject(err);
    };

    const processFrame = () => {
      if (video.readyState < 2) return;
      try {
        thumbCtx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
        const img = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H);
        const gray = toGray(img.data, THUMB_W, THUMB_H);
        if (prevThumb) {
          const { dx, dy } = blockMatch(prevThumb, gray, THUMB_W, THUMB_H, MAX_SHIFT);
          cumX += dx * scaleX;
          cumY += dy * scaleY;
        }
        thumbsX.push(cumX);
        thumbsY.push(cumY);
        prevThumb = gray;
      } catch {
        // Skip frame on transient draw error; keep the path consistent.
      }
      onProgress(Math.min(1, video.currentTime / duration));
    };

    const useRvfc = typeof v.requestVideoFrameCallback === "function";
    if (useRvfc) {
      const onFrame = () => {
        if (finished) return;
        processFrame();
        if (video.ended) {
          finish();
        } else {
          v.requestVideoFrameCallback?.(onFrame);
        }
      };
      v.requestVideoFrameCallback?.(onFrame);
    } else {
      const loop = () => {
        if (finished) return;
        if (!video.paused && video.readyState >= 2) processFrame();
        if (video.ended) finish();
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    video.addEventListener("ended", finish, { once: true });

    video
      .play()
      .then(() => {
        // Watchdog: if currentTime doesn't advance for 5s, the decoder has
        // stalled — better to surface a real error than spin at 0% forever.
        lastWatchdogTime = video.currentTime;
        watchdog = window.setInterval(() => {
          if (finished) return;
          if (video.currentTime <= lastWatchdogTime + 0.05) {
            fail(new Error("Video decoder stalled during analysis"));
            return;
          }
          lastWatchdogTime = video.currentTime;
        }, 5000);
      })
      .catch((e) =>
        fail(new Error("Couldn't play video for analysis: " + (e instanceof Error ? e.message : String(e)))),
      );
  });
}

async function seekToStart(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const onSeeked = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = 0;
    } catch {
      done = true;
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }
    setTimeout(() => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }, 2000);
  });
}

function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

function sad(
  prev: Uint8Array,
  curr: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
): number {
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(w, w + sx);
  const y1 = Math.min(h, h + sy);
  let sum = 0;
  let count = 0;
  const stride = 2;
  for (let y = y0; y < y1; y += stride) {
    const prevRow = y * w;
    const currRow = (y - sy) * w - sx;
    for (let x = x0; x < x1; x += stride) {
      const d = prev[prevRow + x] - curr[currRow + x];
      sum += d < 0 ? -d : d;
      count++;
    }
  }
  return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
}

export function blockMatch(
  prev: Uint8Array,
  curr: Uint8Array,
  w: number,
  h: number,
  maxShift: number,
): { dx: number; dy: number } {
  let bestSad = Number.POSITIVE_INFINITY;
  let bestX = 0;
  let bestY = 0;
  for (let sy = -maxShift; sy <= maxShift; sy++) {
    for (let sx = -maxShift; sx <= maxShift; sx++) {
      const s = sad(prev, curr, w, h, sx, sy);
      if (s < bestSad) {
        bestSad = s;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  let refX = bestX;
  let refY = bestY;
  if (bestX > -maxShift && bestX < maxShift) {
    const sm = sad(prev, curr, w, h, bestX - 1, bestY);
    const sp = sad(prev, curr, w, h, bestX + 1, bestY);
    const denom = sm - 2 * bestSad + sp;
    if (denom > 1e-6) {
      const off = (0.5 * (sm - sp)) / denom;
      if (Math.abs(off) < 1) refX = bestX + off;
    }
  }
  if (bestY > -maxShift && bestY < maxShift) {
    const sm = sad(prev, curr, w, h, bestX, bestY - 1);
    const sp = sad(prev, curr, w, h, bestX, bestY + 1);
    const denom = sm - 2 * bestSad + sp;
    if (denom > 1e-6) {
      const off = (0.5 * (sm - sp)) / denom;
      if (Math.abs(off) < 1) refY = bestY + off;
    }
  }
  return { dx: refX, dy: refY };
}

export function gaussianSmooth(arr: Float32Array, sigma: number): Float32Array {
  const n = arr.length;
  if (n === 0 || sigma <= 0) return arr.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  const denom = 2 * sigma * sigma;
  let kSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / denom);
    kernel[i + radius] = v;
    kSum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      let idx = i + k;
      if (idx < 0) idx = -idx;
      if (idx >= n) idx = 2 * (n - 1) - idx;
      if (idx < 0) idx = 0;
      acc += arr[idx] * kernel[k + radius];
    }
    out[i] = acc;
  }
  return out;
}

export function sigmaForSmoothing(smoothing: number): number {
  const s = Math.max(0, Math.min(1, smoothing));
  return 1 + s * 59;
}

export function frameIndexForTime(result: AnalysisResult, time: number): number {
  const idx = Math.round(time * result.frameRate);
  return Math.max(0, Math.min(result.frameCount - 1, idx));
}
