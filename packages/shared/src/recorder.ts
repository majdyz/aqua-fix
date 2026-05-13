type Candidate = { mime: string; ext: "mp4" | "webm" };

const CANDIDATES: Candidate[] = [
  { mime: "video/mp4;codecs=h264,aac", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9,opus", ext: "webm" },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

export function pickRecorderMime(): Candidate | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      // ignore
    }
  }
  try {
    if (MediaRecorder.isTypeSupported("video/webm")) return { mime: "video/webm", ext: "webm" };
  } catch {
    // ignore
  }
  return null;
}

// Fallback bitrate when we can't estimate the source's. Bits per
// pixel per frame at 0.12 is roughly the H.264 high-quality breakpoint
// where flat regions stop showing block/mosquito noise.
export function pickBitrate(width: number, height: number, fps = 60): number {
  const px = width * height;
  const bpsPerPixel = 0.12 * fps;
  // Cap at 80 Mbps — beyond this Safari's MediaRecorder starts dropping
  // frames or losing the WebGL context.
  return Math.min(80_000_000, Math.max(5_000_000, Math.round(px * bpsPerPixel)));
}

// Estimate the source video's combined bitrate from file size + duration.
// Includes audio + container overhead, which is what we want — using the
// source's total bps as our video target ensures we never lose information
// to encoder quantisation. Capped at 80 Mbps for the Safari ceiling.
export function bitrateFromSource(fileSize: number, durationSec: number): number | null {
  if (!fileSize || !durationSec || durationSec <= 0) return null;
  const bps = (fileSize * 8) / durationSec;
  // Sanity floor / ceiling. Below ~1 Mbps is almost certainly a measurement
  // problem (corrupt metadata); above 80 Mbps Safari falls over.
  if (!Number.isFinite(bps) || bps < 1_000_000) return null;
  return Math.min(80_000_000, Math.round(bps));
}

type CaptureContext = {
  videoStream: MediaStream;
  videoTrack: MediaStreamTrack;
};

export function buildCaptureContext(canvas: HTMLCanvasElement, fps = 60): CaptureContext {
  // Pin the sampler to the detected source fps. The previous ``min(60, fps)``
  // cap was correct when the record loop was rAF-driven (display refresh ≈
  // 60–120 Hz), but the loop now runs on ``requestVideoFrameCallback`` —
  // one render per decoded video frame, decoupled from display refresh.
  // Capping at 60 silently downsamples 120/240 fps slo-mo footage to half
  // its temporal resolution. Passing the source rate keeps every render
  // eligible for capture. Passive mode (no fps argument) drops frames
  // mid-record on iOS Safari, so we always pin a rate.
  //
  // The sampler still runs on its own clock — to keep the captured frames
  // phase-locked with the rVFC renders (so sampler ticks between renders
  // don't grab stale content) callers should also call
  // ``videoTrack.requestFrame()`` immediately after each canvas render.
  // ``requestFrame`` publishes the current canvas backbuffer as a fresh
  // captured frame, overriding the sampler's own clock for that tick.
  const canvasStream = canvas.captureStream(fps);
  const videoTrack = canvasStream.getVideoTracks()[0];
  return { videoStream: canvasStream, videoTrack };
}

const COMMON_FPS = [24, 25, 30, 48, 50, 60, 90, 120, 180, 240];

type RvfcMeta = { mediaTime?: number; presentedFrames?: number };
type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: RvfcMeta) => void) => number;
};

// Measure source fps from requestVideoFrameCallback timestamps. The video
// must be playing for callbacks to fire — caller should call this with a
// playing element (e.g., during preview after autoplay) and await the
// result before starting a recording. Falls back to 60 if rVFC isn't
// available or sampling times out (older browsers).
export async function detectVideoFps(video: HTMLVideoElement, samples = 12): Promise<number> {
  const v = video as VideoWithRVFC;
  if (typeof v.requestVideoFrameCallback !== "function") return 60;

  return new Promise<number>((resolve) => {
    const intervals: number[] = [];
    let lastMediaTime = -1;
    let count = 0;
    let done = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (intervals.length === 0) {
        resolve(60);
        return;
      }
      const sorted = [...intervals].sort((a, b) => a - b);
      // Average the two middle samples for even-length arrays — picking
      // sorted[length>>1] biases the median toward the upper sample,
      // which on borderline rates (29.97, 119.88) snaps the wrong way.
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[sorted.length >> 1];
      const raw = median > 0 ? 1 / median : 60;
      const closest = COMMON_FPS.reduce(
        (a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a),
      );
      resolve(closest);
    };

    const cb = (_now: number, meta: RvfcMeta) => {
      if (done) return;
      const t = meta?.mediaTime;
      if (typeof t === "number" && t >= 0) {
        if (lastMediaTime >= 0) {
          const dt = t - lastMediaTime;
          if (dt > 1e-4 && dt < 1) intervals.push(dt);
        }
        lastMediaTime = t;
      }
      count++;
      if (count < samples + 2) v.requestVideoFrameCallback?.(cb);
      else finish();
    };

    v.requestVideoFrameCallback?.(cb);
    // Hard timeout — if the video isn't decoding for whatever reason,
    // give up rather than block recording. Cleared by finish() on the
    // happy path so we don't pin the closure for 3s after success.
    timeoutId = setTimeout(finish, 3000);
  });
}

type AudioRouting = {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
};

// Web Audio routes the element's audio through a graph; the gain stays at 0 so
// preview is silent locally, while a MediaStreamAudioDestinationNode tap can
// still pull the audio into MediaRecorder when the user starts a save.
//
// IMPORTANT: createMediaElementSource throws on iOS Safari the second time
// it's called for the same <video> element. Callers must keep the returned
// AudioRouting on a ref scoped to the *file* — destroy and null it via
// closeAudioRouting whenever the video element is torn down or its src
// changes, so the next file's first attach call doesn't see a stale source.
export function attachAudioRouting(video: HTMLVideoElement): AudioRouting | null {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
    const source = ctx.createMediaElementSource(video);
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    source.connect(muteGain);
    muteGain.connect(ctx.destination);
    return { ctx, source };
  } catch {
    // createMediaElementSource threw — close the just-allocated context so
    // it doesn't leak (the previous version of this code dropped it on the
    // floor and Safari leaked an AudioContext per failed attach).
    if (ctx) {
      try { ctx.close(); } catch { /* ignore */ }
    }
    return null;
  }
}

// Tear down an AudioRouting. Call from teardownVideo / on file change so a
// new file can attach fresh routing without iOS Safari throwing the
// already-attached error.
export function closeAudioRouting(routing: AudioRouting | null): void {
  if (!routing) return;
  try { routing.source.disconnect(); } catch { /* ignore */ }
  try { routing.ctx.close(); } catch { /* ignore */ }
}

export async function captureAudioForRecording(routing: AudioRouting | null): Promise<{
  tracks: MediaStreamTrack[];
  cleanup: () => void;
}> {
  if (!routing) return { tracks: [], cleanup: () => undefined };
  // Await resume so the destination has live audio frames immediately —
  // fire-and-forget resume meant the first ~few hundred ms of an iOS
  // recording came out silent because the context wasn't running yet
  // when MediaRecorder pulled the first audio chunk.
  if (routing.ctx.state === "suspended") {
    try { await routing.ctx.resume(); } catch { /* ignore */ }
  }
  const dest = routing.ctx.createMediaStreamDestination();
  routing.source.connect(dest);
  return {
    tracks: dest.stream.getAudioTracks(),
    cleanup: () => {
      try {
        routing.source.disconnect(dest);
      } catch {
        // ignore
      }
    },
  };
}

export type RecordingSink = {
  write: (chunk: BlobPart) => Promise<void>;
  finalize: (mimeType: string) => Promise<Blob>;
  cleanup: () => Promise<void>;
};

type StorageWithDirectory = {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

type WritableHandle = FileSystemFileHandle & {
  createWritable?: (options?: { keepExistingData?: boolean }) => Promise<FileSystemWritableFileStream>;
};

export async function pruneOldRecordings(prefix: string): Promise<void> {
  const storage = navigator.storage as Navigator["storage"] & StorageWithDirectory;
  if (!storage || typeof storage.getDirectory !== "function") return;
  try {
    const root = await storage.getDirectory();
    const dir = root as FileSystemDirectoryHandle & {
      values?: () => AsyncIterable<FileSystemHandle>;
    };
    if (typeof dir.values !== "function") return;
    // Only sweep entries older than 10 minutes — without an age check
    // a second tab opening the app would nuke the first tab's
    // in-flight .tmp recording.
    const cutoff = Date.now() - 10 * 60 * 1000;
    for await (const entry of dir.values()) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
      try {
        const fileEntry = entry as FileSystemFileHandle;
        if (typeof fileEntry.getFile === "function") {
          const file = await fileEntry.getFile();
          if (file.lastModified > cutoff) continue;
        }
      } catch {
        // can't stat — fall through and delete defensively
      }
      root.removeEntry(entry.name).catch(() => undefined);
    }
  } catch {
    // ignore
  }
}

export async function createRecordingSink(prefix: string): Promise<RecordingSink> {
  const storage = navigator.storage as Navigator["storage"] & StorageWithDirectory;
  if (storage && typeof storage.getDirectory === "function") {
    try {
      const root = await storage.getDirectory();
      const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
      const handle = (await root.getFileHandle(name, { create: true })) as WritableHandle;
      if (typeof handle.createWritable === "function") {
        const writable = await handle.createWritable();
        let closed = false;
        return {
          write: async (chunk) => {
            if (!closed) await writable.write(chunk);
          },
          finalize: async (mimeType) => {
            if (!closed) {
              await writable.close();
              closed = true;
            }
            const file = await handle.getFile();
            return mimeType ? file.slice(0, file.size, mimeType) : file;
          },
          cleanup: async () => {
            if (!closed) {
              try {
                await writable.close();
              } catch {
                // ignore
              }
              closed = true;
            }
            // Defer entry removal — anchor download is still streaming from it.
            setTimeout(() => {
              root.removeEntry(name).catch(() => undefined);
            }, 60_000);
          },
        };
      }
    } catch {
      // fall through to memory
    }
  }
  const chunks: BlobPart[] = [];
  return {
    write: async (chunk) => {
      chunks.push(chunk);
    },
    finalize: async (mimeType) => new Blob(chunks, { type: mimeType }),
    cleanup: async () => {
      chunks.length = 0;
    },
  };
}

export async function shareOrDownload(blob: Blob, filename: string): Promise<void> {
  // iOS Safari's <a download> is unreliable for large video blobs.
  // Web Share API → opens the iOS share sheet (Photos / Files / AirDrop).
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // No target="_blank" — iOS Safari treats target=_blank+download as
  // "open in a new tab" and ignores the download attribute, leaving the
  // user with a blob URL preview they can't save.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the click has time to start the download, but also
  // revoke on pagehide so users who close the tab quickly don't leak
  // the blob URL until the eventual GC.
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(url);
  };
  setTimeout(revoke, 60_000);
  window.addEventListener("pagehide", revoke, { once: true });
}
