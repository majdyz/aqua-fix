import { useEffect, useRef, useState } from "react";
import { Renderer, computeStats, type Settings, type Stats } from "./lib/correct";
import { buildRecordingStream, pickRecorderMime } from "./lib/recorder";
import "./App.css";

type Mode = "idle" | "photo" | "video";

const DEFAULT_SETTINGS: Settings = {
  intensity: 1.0,
  redBoost: 0.4,
  saturation: 1.1,
};

const PRESETS: { label: string; settings: Settings }[] = [
  { label: "Off", settings: { intensity: 0, redBoost: 0, saturation: 1 } },
  { label: "Shallow", settings: { intensity: 0.8, redBoost: 0.25, saturation: 1.05 } },
  { label: "Reef", settings: { intensity: 1.0, redBoost: 0.4, saturation: 1.1 } },
  { label: "Deep", settings: { intensity: 1.0, redBoost: 0.7, saturation: 1.2 } },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const statsRef = useRef<Stats | null>(null);
  const rafRef = useRef<number>(0);
  const imageBitmapRef = useRef<ImageBitmap | null>(null);
  const fileNameRef = useRef<string>("aqua");
  const recorderRef = useRef<MediaRecorder | null>(null);

  const [mode, setMode] = useState<Mode>("idle");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showOriginal, setShowOriginal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [canRecord, setCanRecord] = useState(true);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      rendererRef.current = new Renderer(canvasRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setCanRecord(pickRecorderMime() !== null);
  }, []);

  useEffect(() => {
    if (mode !== "photo" || !rendererRef.current || !statsRef.current || !imageBitmapRef.current) return;
    rendererRef.current.uploadSource(imageBitmapRef.current, imageBitmapRef.current.width, imageBitmapRef.current.height);
    const effective = showOriginal ? { intensity: 0, redBoost: 0, saturation: 1 } : settings;
    rendererRef.current.render(statsRef.current, effective);
  }, [settings, mode, showOriginal]);

  useEffect(() => {
    if (mode !== "video") return;
    const id = requestAnimationFrame(function loop() {
      if (!rendererRef.current || !statsRef.current || !videoRef.current) return;
      const v = videoRef.current;
      if (v.readyState >= 2 && !v.paused) {
        rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
        const effective = showOriginal ? { intensity: 0, redBoost: 0, saturation: 1 } : settings;
        rendererRef.current.render(statsRef.current, effective);
        if (recording && v.duration) {
          setRecordProgress(v.currentTime / v.duration);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [mode, settings, showOriginal, recording]);

  function teardownVideo() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    recorderRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setRecording(false);
    setRecordProgress(0);
    teardownVideo();
    fileNameRef.current = file.name.replace(/\.[^.]+$/, "");

    if (file.type.startsWith("video/")) {
      await loadVideo(file);
    } else {
      await loadImage(file);
    }
  }

  async function loadImage(file: File) {
    try {
      const bitmap = await createImageBitmap(file);
      imageBitmapRef.current = bitmap;
      const stats = computeStats(bitmap, bitmap.width, bitmap.height);
      statsRef.current = stats;
      setMode("photo");
      requestAnimationFrame(() => {
        if (!rendererRef.current) return;
        rendererRef.current.uploadSource(bitmap, bitmap.width, bitmap.height);
        rendererRef.current.render(stats, settings);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadVideo(file: File) {
    if (!videoRef.current || !rendererRef.current) return;
    const url = URL.createObjectURL(file);
    const video = videoRef.current;
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.loop = true;

    try {
      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => {
          video.removeEventListener("loadeddata", onLoaded);
          video.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          video.removeEventListener("loadeddata", onLoaded);
          video.removeEventListener("error", onError);
          reject(new Error("Could not decode video"));
        };
        video.addEventListener("loadeddata", onLoaded);
        video.addEventListener("error", onError);
      });

      await video.play().catch(() => undefined);

      const sampler = document.createElement("canvas");
      sampler.width = video.videoWidth;
      sampler.height = video.videoHeight;
      const sctx = sampler.getContext("2d", { willReadFrequently: true })!;
      sctx.drawImage(video, 0, 0);
      statsRef.current = computeStats(sampler, sampler.width, sampler.height);
      setDuration(video.duration || 0);
      setMode("video");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function savePhoto() {
    if (!canvasRef.current) return;
    canvasRef.current.toBlob(
      (blob) => {
        if (!blob) return;
        triggerDownload(blob, `${fileNameRef.current}-aqua.jpg`);
      },
      "image/jpeg",
      0.92,
    );
  }

  async function recordVideo() {
    if (!canvasRef.current || !videoRef.current) return;
    const candidate = pickRecorderMime();
    if (!candidate) {
      setError("This browser can't encode video. Try the latest Safari or Chrome.");
      return;
    }
    setError(null);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    video.loop = false;
    video.muted = false;
    try {
      video.currentTime = 0;
    } catch {
      // ignore
    }

    const stream = buildRecordingStream(canvas, video, 30);
    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: candidate.mime || undefined,
        videoBitsPerSecond: 8_000_000,
      });
    } catch (e) {
      setError("Recording failed: " + (e instanceof Error ? e.message : String(e)));
      return;
    }

    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    const stopAndDownload = () =>
      new Promise<void>((resolve) => {
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: candidate.mime || "video/webm" });
          triggerDownload(blob, `${fileNameRef.current}-aqua.${candidate.ext}`);
          resolve();
        };
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });

    const onEnded = async () => {
      video.removeEventListener("ended", onEnded);
      await stopAndDownload();
      setRecording(false);
      setRecordProgress(0);
      video.loop = true;
      video.muted = true;
      video.currentTime = 0;
      await video.play().catch(() => undefined);
    };
    video.addEventListener("ended", onEnded);

    setRecording(true);
    setRecordProgress(0);
    recorder.start(250);
    await video.play().catch(() => undefined);
  }

  function cancelRecording() {
    if (!recorderRef.current || !videoRef.current) return;
    recorderRef.current.ondataavailable = null;
    recorderRef.current.onstop = null;
    try {
      recorderRef.current.stop();
    } catch {
      // ignore
    }
    recorderRef.current = null;
    setRecording(false);
    setRecordProgress(0);
    videoRef.current.loop = true;
    videoRef.current.muted = true;
    videoRef.current.currentTime = 0;
    videoRef.current.play().catch(() => undefined);
  }

  function reset() {
    setSettings(DEFAULT_SETTINGS);
  }

  return (
    <div className="app">
      <div className="bg" aria-hidden="true" />

      <header className="hero">
        <div className="brand">
          <div className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#5fd0ff" />
                  <stop offset="1" stopColor="#2bb89e" />
                </linearGradient>
              </defs>
              <path d="M16 4 C 22 12, 22 20, 16 28 C 10 20, 10 12, 16 4 Z" fill="url(#lg)" />
            </svg>
          </div>
          <div>
            <h1>Aqua Fix</h1>
            <p className="tag">underwater color in your pocket</p>
          </div>
        </div>
      </header>

      <div className={`stage ${mode === "idle" ? "is-empty" : ""}`}>
        <canvas ref={canvasRef} />
        <video ref={videoRef} style={{ display: "none" }} />
        {mode === "idle" && (
          <div className="placeholder">
            <div className="dropper">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3l4 5h-3v6h-2V8H8l4-5zM5 18h14v2H5z"
                  fill="currentColor"
                />
              </svg>
              <p>pick a photo or video</p>
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {recording && (
          <div className="recording-overlay">
            <div className="rec-dot" />
            <span>Recording {Math.round(recordProgress * 100)}%</span>
            <div className="progress">
              <div className="bar" style={{ width: `${recordProgress * 100}%` }} />
            </div>
          </div>
        )}
        {mode !== "idle" && !recording && (
          <button
            className="compare"
            onPointerDown={() => setShowOriginal(true)}
            onPointerUp={() => setShowOriginal(false)}
            onPointerLeave={() => setShowOriginal(false)}
            aria-label="Hold to compare"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v16M5 8l-3 4 3 4M19 8l3 4-3 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {showOriginal ? "Original" : "Hold"}
          </button>
        )}
      </div>

      <section className="panel">
        <label className="file">
          <input
            type="file"
            accept="image/*,video/*"
            disabled={recording}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h14v14H5z M9 9l3-3 3 3M12 6v9" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Pick photo or video
          </span>
        </label>

        {mode !== "idle" && (
          <>
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={`preset ${matchesPreset(settings, p.settings) ? "active" : ""}`}
                  onClick={() => setSettings(p.settings)}
                  disabled={recording}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="sliders">
              <Slider
                label="Intensity"
                value={settings.intensity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, intensity: v }))}
                disabled={recording}
              />
              <Slider
                label="Red boost"
                value={settings.redBoost}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, redBoost: v }))}
                disabled={recording}
              />
              <Slider
                label="Saturation"
                value={settings.saturation}
                min={0}
                max={2}
                step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, saturation: v }))}
                disabled={recording}
              />
            </div>

            <div className="actions">
              <button className="ghost" onClick={reset} disabled={recording}>
                Reset
              </button>
              {mode === "photo" && (
                <button className="primary" onClick={savePhoto}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 19h14M12 4v11M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Save photo
                </button>
              )}
              {mode === "video" && !recording && (
                <button className="primary" onClick={recordVideo} disabled={!canRecord}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="6" fill="currentColor" />
                  </svg>
                  {canRecord ? `Save video${duration ? ` (${duration.toFixed(1)}s)` : ""}` : "Recording unsupported"}
                </button>
              )}
              {mode === "video" && recording && (
                <button className="danger" onClick={cancelRecording}>
                  Cancel
                </button>
              )}
            </div>
            {mode === "video" && !canRecord && (
              <p className="note">This browser can't encode video. The latest Safari, Chrome, or Edge will work.</p>
            )}
          </>
        )}
      </section>

      <footer>
        <p>Tap Share → "Add to Home Screen" to install.</p>
      </footer>
    </div>
  );
}

function matchesPreset(a: Settings, b: Settings, eps = 0.01) {
  return (
    Math.abs(a.intensity - b.intensity) < eps &&
    Math.abs(a.redBoost - b.redBoost) < eps &&
    Math.abs(a.saturation - b.saturation) < eps
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`slider ${disabled ? "is-disabled" : ""}`}>
      <span>
        {label} <em>{value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}
