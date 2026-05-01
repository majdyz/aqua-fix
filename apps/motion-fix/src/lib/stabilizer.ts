// Similarity-transform video stabilizer.
//
// Pipeline:
//   1. Play the source muted at 2x and capture each decoded frame via
//      requestVideoFrameCallback (rAF fallback). Downsample each frame to a
//      128x72 grayscale thumbnail.
//   2. Track a 4x3 grid of points across consecutive thumbnails using small
//      patch-based block matching with sub-pixel parabolic refinement.
//   3. Reject outliers via residual-based trimming, then fit a similarity
//      transform (translation + rotation + uniform scale) using a closed-form
//      least-squares solution (Umeyama 1991, simplified for 2D similarity).
//   4. Compose per-frame transforms into a cumulative camera path.
//   5. Smoothing is applied separately at render time.
//
// Smoothing supports up to sigma 240 frames (~8 seconds at 30Hz) for very
// locked-down looks, and an optional median pre-pass on each path component
// to absorb tracking outliers before Gaussian blur.
//
// This is a Grundmann-Kwatra-Essa-style pipeline minus the L1-optimal path
// solver — Gaussian + median is much smaller code with similar visual results
// for most footage.

const THUMB_W = 128;
const THUMB_H = 72;
const MAX_SHIFT = 16;
const PATCH_R = 6; // patch half-width for feature matching (13x13)
const GRID_X = 4;
const GRID_Y = 3;

export type SimilarityTransform = {
  // Rotation+uniform-scale matrix entries (a = s·cos θ, b = s·sin θ) plus
  // translation. The full 2D map is: x' = a·x − b·y + tx, y' = b·x + a·y + ty.
  a: number;
  b: number;
  tx: number;
  ty: number;
};

export type AnalysisResult = {
  // Cumulative path: per-frame transforms expressed as the absolute
  // similarity that takes frame[0]'s coordinate frame to frame[i]'s.
  // Storing each component as a Float32Array makes Gaussian smoothing trivial.
  cumA: Float32Array;
  cumB: Float32Array;
  cumTX: Float32Array;
  cumTY: Float32Array;
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

  video.muted = true;
  video.loop = false;
  try {
    video.playbackRate = 2;
  } catch {
    // ignore
  }
  if (video.currentTime > 0.05) {
    await seekToStart(video);
  }

  const scaleX = srcW / THUMB_W;
  const scaleY = srcH / THUMB_H;

  // Grid of feature centres on the thumbnail. Avoids the very edge so the
  // patch fits inside the frame with the search window extended.
  const features: { x: number; y: number }[] = [];
  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      features.push({
        x: Math.round(((gx + 1) * THUMB_W) / (GRID_X + 1)),
        y: Math.round(((gy + 1) * THUMB_H) / (GRID_Y + 1)),
      });
    }
  }

  const cumAArr: number[] = [1];
  const cumBArr: number[] = [0];
  const cumTXArr: number[] = [0];
  const cumTYArr: number[] = [0];
  // Cumulative transform state.
  let cumA = 1, cumB = 0, cumTX = 0, cumTY = 0;
  let prevThumb: Uint8Array | null = null;

  const v = video as VideoWithRVFC;

  return new Promise<AnalysisResult>((resolve, reject) => {
    let finished = false;
    let lastWatchdogTime = 0;
    let watchdog: number | null = null;

    const restore = () => {
      try { video.pause(); } catch { /* */ }
      video.muted = wasMuted;
      video.loop = wasLoop;
      try { video.playbackRate = wasRate; } catch { /* */ }
      try { video.currentTime = resumeAt; } catch { /* */ }
      if (!wasPaused) video.play().catch(() => undefined);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      if (watchdog !== null) clearInterval(watchdog);
      restore();
      onProgress(1);
      resolve({
        cumA: Float32Array.from(cumAArr),
        cumB: Float32Array.from(cumBArr),
        cumTX: Float32Array.from(cumTXArr),
        cumTY: Float32Array.from(cumTYArr),
        frameCount: cumAArr.length,
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
          const t = trackAndFit(prevThumb, gray, features, scaleX, scaleY);
          // Compose: cum = cum ∘ t  (apply current frame-to-frame on top of cumulative)
          const newA = cumA * t.a - cumB * t.b;
          const newB = cumA * t.b + cumB * t.a;
          const newTX = cumA * t.tx - cumB * t.ty + cumTX;
          const newTY = cumB * t.tx + cumA * t.ty + cumTY;
          cumA = newA;
          cumB = newB;
          cumTX = newTX;
          cumTY = newTY;
        }
        cumAArr.push(cumA);
        cumBArr.push(cumB);
        cumTXArr.push(cumTX);
        cumTYArr.push(cumTY);
        prevThumb = gray;
      } catch {
        // Repeat last cumulative on draw error so indexing stays consistent.
        cumAArr.push(cumA);
        cumBArr.push(cumB);
        cumTXArr.push(cumTX);
        cumTYArr.push(cumTY);
      }
      onProgress(Math.min(1, video.currentTime / duration));
    };

    const useRvfc = typeof v.requestVideoFrameCallback === "function";
    if (useRvfc) {
      const onFrame = () => {
        if (finished) return;
        processFrame();
        if (video.ended) finish();
        else v.requestVideoFrameCallback?.(onFrame);
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

// Match a small patch from `prev` centred on (cx, cy) into `curr`. Searches
// integer offsets in [-MAX_SHIFT, +MAX_SHIFT]^2, then refines to sub-pixel
// using parabolic fit on the SAD samples around the integer minimum.
function matchPatch(
  prev: Uint8Array,
  curr: Uint8Array,
  cx: number,
  cy: number,
  w: number,
  h: number,
): { dx: number; dy: number; conf: number } | null {
  const r = PATCH_R;
  if (cx - r - MAX_SHIFT < 0 || cx + r + MAX_SHIFT >= w) return null;
  if (cy - r - MAX_SHIFT < 0 || cy + r + MAX_SHIFT >= h) return null;

  const patchSad = (sx: number, sy: number): number => {
    let sum = 0;
    for (let dy = -r; dy <= r; dy++) {
      const py = cy + dy;
      const cyy = cy + dy + sy;
      const prevRow = py * w;
      const currRow = cyy * w;
      for (let dx = -r; dx <= r; dx++) {
        const d = prev[prevRow + cx + dx] - curr[currRow + cx + dx + sx];
        sum += d < 0 ? -d : d;
      }
    }
    return sum;
  };

  let bestSad = Number.POSITIVE_INFINITY;
  let bestX = 0;
  let bestY = 0;
  for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
    for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
      const s = patchSad(sx, sy);
      if (s < bestSad) {
        bestSad = s;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  // Sub-pixel parabolic refine.
  let refX = bestX;
  let refY = bestY;
  if (bestX > -MAX_SHIFT && bestX < MAX_SHIFT) {
    const sm = patchSad(bestX - 1, bestY);
    const sp = patchSad(bestX + 1, bestY);
    const denom = sm - 2 * bestSad + sp;
    if (denom > 1e-6) {
      const off = (0.5 * (sm - sp)) / denom;
      if (Math.abs(off) < 1) refX = bestX + off;
    }
  }
  if (bestY > -MAX_SHIFT && bestY < MAX_SHIFT) {
    const sm = patchSad(bestX, bestY - 1);
    const sp = patchSad(bestX, bestY + 1);
    const denom = sm - 2 * bestSad + sp;
    if (denom > 1e-6) {
      const off = (0.5 * (sm - sp)) / denom;
      if (Math.abs(off) < 1) refY = bestY + off;
    }
  }

  // Confidence proxy: how distinct is the minimum from its neighbour?
  // If the patch is on a low-texture region the SAD landscape is almost flat
  // and we'd rather drop this match than trust it.
  const sN = patchSad(bestX + 2, bestY) + patchSad(bestX - 2, bestY) +
             patchSad(bestX, bestY + 2) + patchSad(bestX, bestY - 2);
  const conf = (sN / 4 - bestSad) / (bestSad + 1);

  return { dx: refX, dy: refY, conf };
}

// Track the grid into the current frame, fit a 2D similarity transform from
// the inlier matches. Returns identity if too few inliers — so a momentarily
// dropped frame doesn't perturb the cumulative path.
function trackAndFit(
  prev: Uint8Array,
  curr: Uint8Array,
  features: { x: number; y: number }[],
  scaleX: number,
  scaleY: number,
): SimilarityTransform {
  type Match = { px: number; py: number; qx: number; qy: number };
  const matches: Match[] = [];
  const confidences: number[] = [];

  for (const f of features) {
    const m = matchPatch(prev, curr, f.x, f.y, THUMB_W, THUMB_H);
    if (!m) continue;
    if (m.conf < 0.04) continue;
    matches.push({ px: f.x, py: f.y, qx: f.x + m.dx, qy: f.y + m.dy });
    confidences.push(m.conf);
  }

  if (matches.length < 3) return { a: 1, b: 0, tx: 0, ty: 0 };

  // Initial similarity fit on all matches.
  let fit = fitSimilarity(matches);
  if (!fit) return { a: 1, b: 0, tx: 0, ty: 0 };

  // Trim outliers — drop the matches with the worst residuals (top ~25% or
  // residuals above a fixed threshold) and re-fit.
  const residuals = matches.map((m) => {
    const ex = fit!.a * m.px - fit!.b * m.py + fit!.tx - m.qx;
    const ey = fit!.b * m.px + fit!.a * m.py + fit!.ty - m.qy;
    return Math.sqrt(ex * ex + ey * ey);
  });
  const sorted = residuals.slice().sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(1.5, median * 2.5);
  const inliers = matches.filter((_, i) => residuals[i] <= threshold);

  if (inliers.length >= 3) {
    const refined = fitSimilarity(inliers);
    if (refined) fit = refined;
  }

  // Convert thumbnail-space transform to source-space. Translation scales by
  // the source/thumb ratio. Rotation + uniform scale (a, b) are dimensionless
  // and apply identically. The ratio between scaleX and scaleY is small for
  // typical 16:9 footage, so use the average for a "uniform" scale-up.
  const avgScale = (scaleX + scaleY) * 0.5;
  return {
    a: fit.a,
    b: fit.b,
    tx: fit.tx * avgScale,
    ty: fit.ty * avgScale,
  };
}

// Closed-form 2D similarity fit by least squares.
// Solves for (a, b, tx, ty) minimising sum |q - T(p)|^2 over matches, where
//   T(p) = (a·px - b·py + tx, b·px + a·py + ty).
// Decomposed: subtract centroids so tx/ty drop out, fit (a, b), then recover
// tx/ty.
function fitSimilarity(
  matches: { px: number; py: number; qx: number; qy: number }[],
): SimilarityTransform | null {
  const n = matches.length;
  if (n < 2) return null;
  let pcx = 0, pcy = 0, qcx = 0, qcy = 0;
  for (const m of matches) {
    pcx += m.px;
    pcy += m.py;
    qcx += m.qx;
    qcy += m.qy;
  }
  pcx /= n; pcy /= n; qcx /= n; qcy /= n;

  // Centred coords. Solve for (a, b):
  //   sum (a·px - b·py - qx)·px + (b·px + a·py - qy)·py = 0
  //   sum -(a·px - b·py - qx)·py + (b·px + a·py - qy)·px = 0
  // After centring, this reduces to:
  //   a · sum(px² + py²) = sum(px·qx + py·qy)
  //   b · sum(px² + py²) = sum(px·qy − py·qx)
  let sumP2 = 0;
  let crossA = 0;
  let crossB = 0;
  for (const m of matches) {
    const dpx = m.px - pcx;
    const dpy = m.py - pcy;
    const dqx = m.qx - qcx;
    const dqy = m.qy - qcy;
    sumP2 += dpx * dpx + dpy * dpy;
    crossA += dpx * dqx + dpy * dqy;
    crossB += dpx * dqy - dpy * dqx;
  }
  if (sumP2 < 1e-6) return null;
  const a = crossA / sumP2;
  const b = crossB / sumP2;
  // Recover translation.
  const tx = qcx - (a * pcx - b * pcy);
  const ty = qcy - (b * pcx + a * pcy);
  return { a, b, tx, ty };
}

// Median filter over a 1D path. Removes spikes from a single bad frame
// before Gaussian smoothing softens the rest.
export function medianFilter(arr: Float32Array, radius: number): Float32Array {
  if (radius < 1) return arr.slice();
  const n = arr.length;
  const out = new Float32Array(n);
  const buf = new Float32Array(radius * 2 + 1);
  for (let i = 0; i < n; i++) {
    let count = 0;
    for (let k = -radius; k <= radius; k++) {
      let idx = i + k;
      if (idx < 0) idx = -idx;
      if (idx >= n) idx = 2 * (n - 1) - idx;
      if (idx < 0) idx = 0;
      buf[count++] = arr[idx];
    }
    const view = buf.subarray(0, count);
    view.sort();
    out[i] = view[count >> 1];
  }
  return out;
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

// Smooth the cumulative path: median pre-filter to absorb tracking spikes,
// then Gaussian to mimic a smooth professional camera move. Maps slider 0..1
// to a much wider sigma range (4..240 frames at 30Hz, i.e. 0.13s..8s).
export function smoothPath(
  result: AnalysisResult,
  smoothing: number,
): {
  smoothA: Float32Array;
  smoothB: Float32Array;
  smoothTX: Float32Array;
  smoothTY: Float32Array;
} {
  const sigma = sigmaForSmoothing(smoothing);
  // Light median pre-pass; radius scales with sigma but is capped.
  const medRadius = Math.min(5, Math.max(1, Math.round(sigma / 12)));
  const aMed = medianFilter(result.cumA, medRadius);
  const bMed = medianFilter(result.cumB, medRadius);
  const txMed = medianFilter(result.cumTX, medRadius);
  const tyMed = medianFilter(result.cumTY, medRadius);
  return {
    smoothA: gaussianSmooth(aMed, sigma),
    smoothB: gaussianSmooth(bMed, sigma),
    smoothTX: gaussianSmooth(txMed, sigma),
    smoothTY: gaussianSmooth(tyMed, sigma),
  };
}

export function sigmaForSmoothing(smoothing: number): number {
  const s = Math.max(0, Math.min(1, smoothing));
  // Quadratic ramp so the slider has fine control near the low end.
  return 4 + (s * s) * 236;
}

export function frameIndexForTime(result: AnalysisResult, time: number): number {
  const idx = Math.round(time * result.frameRate);
  return Math.max(0, Math.min(result.frameCount - 1, idx));
}

// Inverse residual transform: the transform that takes the wobbly "raw" frame
// to the smoothed virtual camera. We compose: stabilized = smoothed ∘ raw⁻¹.
// Returns parameters for ctx.setTransform(a, b, c, d, e, f) where the matrix
// maps the source frame coordinates to the canvas coordinates. The 2D affine
// (a, b, c, d, e, f) form of a similarity transform with a = sCosθ, b = sSinθ
// is (a, b, -b, a, tx, ty).
export function residualTransform(
  result: AnalysisResult,
  smooth: ReturnType<typeof smoothPath>,
  frame: number,
): SimilarityTransform {
  // raw similarity at this frame
  const ra = result.cumA[frame];
  const rb = result.cumB[frame];
  const rtx = result.cumTX[frame];
  const rty = result.cumTY[frame];
  // smooth similarity at this frame
  const sa = smooth.smoothA[frame];
  const sb = smooth.smoothB[frame];
  const stx = smooth.smoothTX[frame];
  const sty = smooth.smoothTY[frame];

  // residual = smooth ∘ raw⁻¹
  // raw⁻¹ has params:
  //   denom = ra² + rb²
  //   ia =  ra / denom
  //   ib = -rb / denom
  //   itx = -(ia·rtx - ib·rty)
  //   ity = -(ib·rtx + ia·rty)
  const denom = ra * ra + rb * rb;
  if (denom < 1e-9) return { a: 1, b: 0, tx: 0, ty: 0 };
  const ia = ra / denom;
  const ib = -rb / denom;
  const itx = -(ia * rtx - ib * rty);
  const ity = -(ib * rtx + ia * rty);
  // smooth ∘ inverse(raw)
  const a = sa * ia - sb * ib;
  const b = sa * ib + sb * ia;
  const tx = sa * itx - sb * ity + stx;
  const ty = sb * itx + sa * ity + sty;
  return { a, b, tx, ty };
}
