import { useEffect, useRef, useState } from "react";
import {
  BusyOverlay,
  FilePickerButton,
  Hero,
  PlaceholderDropZone,
  PlayOverlay,
  Scrubber,
  Slider,
  useVideoPlaybackState,
} from "@dive-tools/shared";
import "@dive-tools/shared/theme.css";
import "./motion-theme.css";
import { MotionFixLogo, MOTION_FIX_BRAND } from "./branding";

type Mode = "idle" | "video";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [smoothing, setSmoothing] = useState(0.6);
  const [crop, setCrop] = useState(0.1);
  const recording = false;

  const { currentTime, isPaused } = useVideoPlaybackState(videoRef, mode === "video");

  // Render the live frame onto the canvas. Stabilization not implemented yet —
  // this is a placeholder pass-through so the shell, slider, scrubber, and
  // play/pause behave like the rest of the suite.
  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || mode !== "video") return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const loop = () => {
      if (v.readyState >= 2 && !v.paused) {
        if (c.width !== v.videoWidth) c.width = v.videoWidth;
        if (c.height !== v.videoHeight) c.height = v.videoHeight;
        ctx.drawImage(v, 0, 0, c.width, c.height);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  async function handleFile(file: File) {
    setError(null);
    setBusy("Loading video…");
    try {
      const v = videoRef.current;
      if (!v) return;
      v.src = URL.createObjectURL(file);
      v.muted = true;
      v.playsInline = true;
      v.loop = true;
      v.preload = "auto";
      if (v.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          const onMeta = () => {
            v.removeEventListener("loadedmetadata", onMeta);
            v.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            v.removeEventListener("loadedmetadata", onMeta);
            v.removeEventListener("error", onErr);
            reject(new Error("Could not decode video"));
          };
          v.addEventListener("loadedmetadata", onMeta);
          v.addEventListener("error", onErr);
        });
      }
      v.play().catch(() => undefined);
      setDuration(v.duration || 0);
      setMode("video");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }

  function seekTo(t: number) {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.min(Math.max(0, t), v.duration || 0);
    } catch {
      // ignore
    }
  }

  return (
    <div className="app motion-app">
      <div className="bg" aria-hidden="true" />

      <Hero
        logo={<MotionFixLogo />}
        name={MOTION_FIX_BRAND.name}
        tagline={MOTION_FIX_BRAND.tagline}
      />

      <div
        className={`stage ${mode === "idle" ? "is-empty" : ""}`}
        onClick={(e) => {
          if (mode !== "video") return;
          if ((e.target as HTMLElement).closest("button")) return;
          togglePlay();
        }}
      >
        <canvas ref={canvasRef} />
        <video ref={videoRef} style={{ display: "none" }} />
        {mode === "idle" && (
          <PlaceholderDropZone
            accept="video/*"
            onPick={handleFile}
            message="tap to pick a video"
          />
        )}
        {error && <div className="error">{error}</div>}
        {busy && <BusyOverlay message={busy} />}
        {mode === "video" && isPaused && <PlayOverlay />}
      </div>

      {mode === "video" && (
        <Scrubber
          currentTime={currentTime}
          duration={duration}
          disabled={recording}
          onSeek={seekTo}
        />
      )}

      <section className="panel">
        <FilePickerButton accept="video/*" onPick={handleFile}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M5 5h14v14H5z M9 9l3-3 3 3M12 6v9"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Pick a video
        </FilePickerButton>

        {mode === "video" && (
          <>
            <p className="motion-coming-soon">
              Stabilization processor is in progress — sliders preview the
              UI shape. The first build will use feature tracking + Gaussian
              path smoothing (translation+rotation).
            </p>
            <div className="sliders">
              <Slider
                label="Smoothing"
                value={smoothing}
                min={0}
                max={1}
                step={0.01}
                onChange={setSmoothing}
              />
              <Slider
                label="Max crop"
                value={crop}
                min={0}
                max={0.3}
                step={0.005}
                onChange={setCrop}
              />
            </div>
            <div className="actions">
              <button className="primary" disabled>
                Save stabilised video
              </button>
            </div>
          </>
        )}
      </section>

      <footer>
        <p>
          Companion to{" "}
          <a href="../" style={{ color: "var(--motion-accent, #ff8b4a)" }}>
            Aqua Fix
          </a>
          . Tap Share → "Add to Home Screen".
        </p>
      </footer>
    </div>
  );
}
