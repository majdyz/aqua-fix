import { useEffect, useRef, useState } from "react";
import { Renderer, computeStats, type Settings, type Stats } from "./lib/correct";
import "./App.css";

type Mode = "idle" | "photo" | "video";

const DEFAULT_SETTINGS: Settings = {
  intensity: 1.0,
  redBoost: 0.4,
  saturation: 1.1,
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const statsRef = useRef<Stats | null>(null);
  const rafRef = useRef<number>(0);
  const imageBitmapRef = useRef<ImageBitmap | null>(null);
  const fileNameRef = useRef<string>("aqua");

  const [mode, setMode] = useState<Mode>("idle");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showOriginal, setShowOriginal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      rendererRef.current = new Renderer(canvasRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (mode !== "photo" || !rendererRef.current || !statsRef.current || !imageBitmapRef.current) return;
    rendererRef.current.uploadSource(imageBitmapRef.current, imageBitmapRef.current.width, imageBitmapRef.current.height);
    const effective = showOriginal ? { intensity: 0, redBoost: 0, saturation: 1 } : settings;
    rendererRef.current.render(statsRef.current, effective);
  }, [settings, mode, showOriginal]);

  function stopVideoLoop() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
  }

  async function handleFile(file: File) {
    setError(null);
    stopVideoLoop();
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

    setMode("video");

    const tick = () => {
      if (!rendererRef.current || !statsRef.current || !videoRef.current) return;
      const v = videoRef.current;
      if (v.readyState >= 2 && !v.paused) {
        rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
        const effective = showOriginal ? { intensity: 0, redBoost: 0, saturation: 1 } : settings;
        rendererRef.current.render(statsRef.current, effective);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  useEffect(() => {
    if (mode !== "video") return;
    const id = requestAnimationFrame(function loop() {
      if (!rendererRef.current || !statsRef.current || !videoRef.current) return;
      const v = videoRef.current;
      if (v.readyState >= 2 && !v.paused) {
        rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
        const effective = showOriginal ? { intensity: 0, redBoost: 0, saturation: 1 } : settings;
        rendererRef.current.render(statsRef.current, effective);
      }
      rafRef.current = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [mode, settings, showOriginal]);

  function savePhoto() {
    if (!canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileNameRef.current}-aqua.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/jpeg", 0.92);
  }

  function reset() {
    setSettings(DEFAULT_SETTINGS);
  }

  return (
    <div className="app">
      <header>
        <h1>Aqua Fix</h1>
        <p className="tag">underwater color correction</p>
      </header>

      <div className="stage">
        <canvas ref={canvasRef} />
        <video ref={videoRef} style={{ display: "none" }} />
        {mode === "idle" && <div className="placeholder">pick a photo or video to begin</div>}
        {error && <div className="error">{error}</div>}
      </div>

      <div className="controls">
        <label className="file">
          <input
            type="file"
            accept="image/*,video/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <span>Pick photo / video</span>
        </label>

        {mode !== "idle" && (
          <>
            <Slider
              label="Intensity"
              value={settings.intensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setSettings((s) => ({ ...s, intensity: v }))}
            />
            <Slider
              label="Red boost"
              value={settings.redBoost}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setSettings((s) => ({ ...s, redBoost: v }))}
            />
            <Slider
              label="Saturation"
              value={settings.saturation}
              min={0}
              max={2}
              step={0.01}
              onChange={(v) => setSettings((s) => ({ ...s, saturation: v }))}
            />

            <div className="row">
              <button
                onPointerDown={() => setShowOriginal(true)}
                onPointerUp={() => setShowOriginal(false)}
                onPointerLeave={() => setShowOriginal(false)}
              >
                Hold to compare
              </button>
              <button onClick={reset}>Reset</button>
              {mode === "photo" && (
                <button className="primary" onClick={savePhoto}>
                  Save photo
                </button>
              )}
            </div>
            {mode === "video" && (
              <p className="note">Video preview only — saving corrected video isn't supported on iOS Safari yet.</p>
            )}
          </>
        )}
      </div>

      <footer>
        <p>Install: tap the share icon in Safari, then "Add to Home Screen".</p>
      </footer>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span>
        {label} <em>{value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}
