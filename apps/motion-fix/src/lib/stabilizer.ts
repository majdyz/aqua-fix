// Translation-only video stabilizer.
//
// Pipeline:
//   1. Walk the source video frame-by-frame, downsampling each frame to a tiny
//      grayscale thumbnail.
//   2. For consecutive thumbnails, find the integer (dx, dy) shift that
//      minimises sum-of-absolute-differences over their overlap, search
//      window +/- MAX_SHIFT.
//   3. Refine to sub-pixel using parabolic interpolation on the 3 SAD samples
//      around the integer minimum, separately along x and y.
//   4. Scale up by source/thumb ratio and accumulate to get the camera path.
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

  // Pause and reset the element — analysis owns it for the duration of the
  // pass and we don't want autoplay racing with our seek loop.
  const wasPaused = video.paused;
  const resumeAt = video.currentTime;
  const wasMuted = video.muted;
  const wasLoop = video.loop;
  video.pause();
  video.muted = true;
  video.loop = false;

  // We sample on a fixed 30Hz grid regardless of the source frame rate so
  // the smoothing-slider sigma (in frames) maps to a consistent time window.
  const frameRate = 30;

  const scaleX = srcW / THUMB_W;
  const scaleY = srcH / THUMB_H;

  const thumbsX: number[] = [];
  const thumbsY: number[] = [];
  let cumX = 0;
  let cumY = 0;
  thumbsX.push(0);
  thumbsY.push(0);

  let prevThumb: Uint8Array | null = null;

  const sampleStep = 1 / 30;
  const totalFrames = Math.max(1, Math.floor(duration * 30));

  for (let i = 0; i < totalFrames; i++) {
    const t = Math.min(duration, i * sampleStep);
    await seekTo(video, t);
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

    if (i % 4 === 0 || i === totalFrames - 1) {
      onProgress((i + 1) / totalFrames);
      // Yield so the UI can repaint the progress label.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Restore element state.
  try {
    video.currentTime = resumeAt;
  } catch {
    // ignore
  }
  video.muted = wasMuted;
  video.loop = wasLoop;
  if (!wasPaused) video.play().catch(() => undefined);

  const frameCount = thumbsX.length;
  const out: AnalysisResult = {
    cumX: Float32Array.from(thumbsX),
    cumY: Float32Array.from(thumbsY),
    frameCount,
    frameRate,
  };
  return out;
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onSeeked = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("Seek failed"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      // Tiny epsilon stops Safari short-circuiting an identical-time seek.
      const target = Math.abs(video.currentTime - t) < 1e-4 ? t + 1e-4 : t;
      video.currentTime = target;
    } catch {
      onError();
    }
  });
}

function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    // Rec. 601 luma — fast and good enough for matching.
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

// SAD over the overlap region for shift (sx, sy). prev is the reference,
// curr is sampled at offsets (x+sx, y+sy). We sample on a stride to make
// the search faster — full-pixel match isn't needed, we only need a clear
// minimum to fit a parabola around.
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

  // Sub-pixel parabolic refine. Parabola through (s-1, s, s+1):
  //   offset = 0.5 * (s_minus - s_plus) / (s_minus - 2*s + s_plus)
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

// Separable 1D Gaussian, mirror-padded at the edges.
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

// Maps the smoothing slider (0..1) to a Gaussian sigma in frames (1..60).
export function sigmaForSmoothing(smoothing: number): number {
  const s = Math.max(0, Math.min(1, smoothing));
  return 1 + s * 59;
}

// Picks the integer index into cumX / cumY for a given playback time.
export function frameIndexForTime(
  result: AnalysisResult,
  time: number,
): number {
  const idx = Math.round(time * result.frameRate);
  return Math.max(0, Math.min(result.frameCount - 1, idx));
}
