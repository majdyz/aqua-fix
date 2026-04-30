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

export function buildRecordingStream(canvas: HTMLCanvasElement, video: HTMLVideoElement, fps = 30): MediaStream {
  const canvasStream = canvas.captureStream(fps);
  const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

  const sourceWithCapture = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  try {
    const sourceStream = (sourceWithCapture.captureStream?.() ?? sourceWithCapture.mozCaptureStream?.());
    if (sourceStream) {
      for (const t of sourceStream.getAudioTracks()) tracks.push(t);
    }
  } catch {
    // audio capture not supported, video-only output
  }
  return new MediaStream(tracks);
}
