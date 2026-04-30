import { useEffect, useRef, useState } from "react";
import {
  AdvancedDisclosure,
  attachAudioRouting,
  buildCaptureContext,
  BusyOverlay,
  captureAudioForRecording,
  CompareButton,
  createRecordingSink,
  FilePickerButton,
  Hero,
  PlaceholderDropZone,
  PlayOverlay,
  PresetsRow,
  pickBitrate,
  pickRecorderMime,
  pruneOldRecordings,
  RecordingOverlay,
  type RecordingSink,
  Scrubber,
  shareOrDownload,
  Slider,
  useVideoPlaybackState,
} from "@dive-tools/shared";
import "@dive-tools/shared/theme.css";
import { Renderer, computeStats, type Settings, type Stats } from "./lib/correct";
import { parseCube } from "./lib/lut";
import { AquaFixLogo, AQUA_FIX_BRAND } from "./branding";

type Mode = "idle" | "photo" | "video";

const DEFAULT_SETTINGS: Settings = {
  intensity: 1.0,
  castStrength: 0.85,
  saturation: 1.18,
  gamma: 0.92,
  contrast: 0.3,
  clahe: 0.6,
  lutMix: 1.0,
};

const OFF_SETTINGS: Settings = {
  intensity: 0,
  castStrength: 0,
  saturation: 1,
  gamma: 1,
  contrast: 0,
  clahe: 0,
  lutMix: 0,
};

const IDENTITY_TONE_LUT = (() => {
  const a = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    a[i * 4] = i;
    a[i * 4 + 1] = i;
    a[i * 4 + 2] = i;
    a[i * 4 + 3] = 255;
  }
  return a;
})();

const IDENTITY_STATS: Stats = {
  mean: [0.5, 0.5, 0.5],
  wbGain: [1, 1, 1],
  min: [0, 0, 0],
  max: [1, 1, 1],
  alpha: 0,
  toneLUT: IDENTITY_TONE_LUT,
};

const PRESETS: { label: string; settings: Settings }[] = [
  { label: "Off", settings: OFF_SETTINGS },
  { label: "Shallow", settings: { intensity: 0.85, castStrength: 0.55, saturation: 1.1, gamma: 0.96, contrast: 0.18, clahe: 0.4, lutMix: 1.0 } },
  { label: "Reef", settings: DEFAULT_SETTINGS },
  { label: "Deep", settings: { intensity: 1.0, castStrength: 1.0, saturation: 1.3, gamma: 0.86, contrast: 0.4, clahe: 0.75, lutMix: 1.0 } },
];

type AudioRouting = ReturnType<typeof attachAudioRouting>;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const statsRef = useRef<Stats | null>(null);
  const imageBitmapRef = useRef<ImageBitmap | null>(null);
  const fileNameRef = useRef<string>(AQUA_FIX_BRAND.filenamePrefix);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const previewActiveRef = useRef(false);
  const recordingFlagRef = useRef(false);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const showOriginalRef = useRef(false);
  const audioRoutingRef = useRef<AudioRouting>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const onEndedRef = useRef<(() => void) | null>(null);
  const sinkRef = useRef<RecordingSink | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lastStatsRefreshRef = useRef(0);

  const [mode, setMode] = useState<Mode>("idle");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showOriginal, setShowOriginal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordTime, setRecordTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [canRecord, setCanRecord] = useState(true);
  const [lutName, setLutName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    showOriginalRef.current = showOriginal;
  }, [showOriginal]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    try {
      rendererRef.current = new Renderer(canvas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setCanRecord(pickRecorderMime() !== null);
    pruneOldRecordings(AQUA_FIX_BRAND.opfsPrefix);

    const onLost = (e: Event) => {
      e.preventDefault();
      setError("GPU context lost — try a smaller video or reload the page");
      recordingFlagRef.current = false;
    };
    const onRestored = () => {
      try {
        rendererRef.current = new Renderer(canvas);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, []);

  useEffect(() => {
    if (mode !== "photo" || !rendererRef.current || !imageBitmapRef.current) return;
    const bitmap = imageBitmapRef.current;
    statsRef.current = computeStats(bitmap, bitmap.width, bitmap.height, settings.castStrength);
    rendererRef.current.uploadSource(bitmap, bitmap.width, bitmap.height);
    const eff = showOriginal ? OFF_SETTINGS : settings;
    rendererRef.current.render(statsRef.current, eff);
  }, [settings, mode, showOriginal]);

  useEffect(() => {
    if (mode !== "video" || !videoRef.current || videoRef.current.readyState < 2) return;
    const v = videoRef.current;
    statsRef.current = computeStats(v, v.videoWidth, v.videoHeight, settings.castStrength);
  }, [settings.castStrength, mode]);

  const { currentTime, isPaused } = useVideoPlaybackState(videoRef, mode === "video", () => {
    const v = videoRef.current;
    if (!v || !rendererRef.current || !statsRef.current || v.readyState < 2) return;
    rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
    const eff = showOriginalRef.current ? OFF_SETTINGS : settingsRef.current;
    rendererRef.current.render(statsRef.current, eff);
  });

  // Repaint the frozen frame when settings change while paused.
  useEffect(() => {
    if (mode !== "video") return;
    const v = videoRef.current;
    if (!v || !rendererRef.current || !statsRef.current) return;
    if (!v.paused || v.readyState < 2) return;
    rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
    const eff = showOriginal ? OFF_SETTINGS : settings;
    rendererRef.current.render(statsRef.current, eff);
  }, [settings, showOriginal, isPaused, mode]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v || recording) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }

  function seekTo(t: number) {
    const v = videoRef.current;
    if (!v || recording) return;
    try {
      v.currentTime = Math.min(Math.max(0, t), v.duration || 0);
    } catch {
      // ignore
    }
  }

  function maybeRefreshStats(video: HTMLVideoElement) {
    const now = performance.now();
    if (now - lastStatsRefreshRef.current < 1000) return;
    if (video.readyState < 2) return;
    try {
      const fresh = computeStats(video, video.videoWidth, video.videoHeight, settingsRef.current.castStrength);
      const cur = statsRef.current;
      if (cur && cur !== IDENTITY_STATS) {
        statsRef.current = lerpStats(cur, fresh, 0.15);
      } else {
        statsRef.current = fresh;
      }
      lastStatsRefreshRef.current = now;
    } catch {
      // ignore
    }
  }

  type VideoWithRVFC = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number;
  };

  function startPreview() {
    const video = videoRef.current as VideoWithRVFC | null;
    if (!video) return;
    previewActiveRef.current = true;
    lastStatsRefreshRef.current = 0;

    const renderFromVideo = () => {
      if (!rendererRef.current || !statsRef.current || !videoRef.current) return;
      const v = videoRef.current;
      if (v.readyState < 2) return;
      maybeRefreshStats(v);
      rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
      const eff = showOriginalRef.current ? OFF_SETTINGS : settingsRef.current;
      rendererRef.current.render(statsRef.current, eff);
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        if (!previewActiveRef.current || recordingFlagRef.current) return;
        renderFromVideo();
        const v = videoRef.current as VideoWithRVFC | null;
        if (v && previewActiveRef.current && !recordingFlagRef.current) {
          v.requestVideoFrameCallback?.(onFrame);
        }
      };
      video.requestVideoFrameCallback(onFrame);
    } else {
      const loop = () => {
        if (!previewActiveRef.current || recordingFlagRef.current) return;
        renderFromVideo();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  function teardownVideo() {
    previewActiveRef.current = false;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    recorderRef.current = null;
    recordingFlagRef.current = false;
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
    const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
    setBusy(isVideo ? "Loading video…" : "Loading photo…");
    try {
      if (isVideo) await loadVideo(file);
      else await loadImage(file);
    } finally {
      setBusy(null);
    }
  }

  async function handleLUTFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseCube(text);
      if (rendererRef.current) {
        rendererRef.current.uploadLUT(parsed.data, parsed.size);
      }
      setLutName(file.name);
      if (mode === "photo" && rendererRef.current && imageBitmapRef.current && statsRef.current) {
        rendererRef.current.uploadSource(imageBitmapRef.current, imageBitmapRef.current.width, imageBitmapRef.current.height);
        rendererRef.current.render(statsRef.current, showOriginal ? OFF_SETTINGS : settings);
      }
    } catch (e) {
      setError("LUT load failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function clearLUT() {
    if (rendererRef.current) rendererRef.current.clearLUT();
    setLutName(null);
    if (mode === "photo" && rendererRef.current && imageBitmapRef.current && statsRef.current) {
      rendererRef.current.uploadSource(imageBitmapRef.current, imageBitmapRef.current.width, imageBitmapRef.current.height);
      rendererRef.current.render(statsRef.current, showOriginal ? OFF_SETTINGS : settings);
    }
  }

  async function loadImage(file: File) {
    try {
      const bitmap = await createImageBitmap(file);
      imageBitmapRef.current = bitmap;
      const stats = computeStats(bitmap, bitmap.width, bitmap.height, settingsRef.current.castStrength);
      statsRef.current = stats;
      setMode("photo");
      requestAnimationFrame(() => {
        if (!rendererRef.current) return;
        rendererRef.current.uploadSource(bitmap, bitmap.width, bitmap.height);
        rendererRef.current.render(stats, settingsRef.current);
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
    video.preload = "auto";

    try {
      if (video.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          const onMeta = () => {
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("error", onErr);
            reject(new Error("Could not decode video"));
          };
          video.addEventListener("loadedmetadata", onMeta);
          video.addEventListener("error", onErr);
        });
      }

      video.play().catch(() => undefined);
      statsRef.current = IDENTITY_STATS;
      setDuration(video.duration || 0);
      setMode("video");
      startPreview();

      const computeOnce = () => {
        const v = videoRef.current;
        if (!v || v.readyState < 2) return;
        try {
          statsRef.current = computeStats(v, v.videoWidth, v.videoHeight, settingsRef.current.castStrength);
        } catch {
          // ignore
        }
      };
      if (video.readyState >= 2) computeOnce();
      else {
        const onCanPlay = () => {
          video.removeEventListener("canplay", onCanPlay);
          computeOnce();
        };
        video.addEventListener("canplay", onCanPlay);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function savePhoto() {
    if (!canvasRef.current) return;
    canvasRef.current.toBlob(
      (blob) => {
        if (!blob) return;
        shareOrDownload(blob, `${fileNameRef.current}-aqua.jpg`).catch(() => undefined);
      },
      "image/jpeg",
      0.95,
    );
  }

  async function recordVideo() {
    try {
      await recordVideoInner();
    } catch (e) {
      recordingFlagRef.current = false;
      if (audioCleanupRef.current) {
        audioCleanupRef.current();
        audioCleanupRef.current = null;
      }
      if (sinkRef.current) {
        sinkRef.current.cleanup().catch(() => undefined);
        sinkRef.current = null;
      }
      setRecording(false);
      setError("Recording failed: " + (e instanceof Error ? e.message : String(e)));
      startPreview();
    }
  }

  async function recordVideoInner() {
    const canvas = canvasRef.current;
    const video = videoRef.current as VideoWithRVFC | null;
    if (!canvas || !video || !statsRef.current) return;
    const candidate = pickRecorderMime();
    if (!candidate) {
      setError("This browser can't encode video. Try the latest Safari or Chrome.");
      return;
    }
    setError(null);
    previewActiveRef.current = false;
    recordingFlagRef.current = true;

    video.pause();
    video.loop = false;
    video.muted = false;
    if (video.currentTime > 0.01) {
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        try {
          video.currentTime = 0;
        } catch {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      });
    }

    const wakeLockApi = (navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    }).wakeLock;
    if (wakeLockApi && typeof wakeLockApi.request === "function") {
      wakeLockApi
        .request("screen")
        .then((lock) => {
          wakeLockRef.current = lock;
        })
        .catch(() => undefined);
    }

    if (rendererRef.current) {
      rendererRef.current.uploadSource(video, video.videoWidth, video.videoHeight);
      rendererRef.current.render(statsRef.current, settingsRef.current);
    }

    const captureCtx = buildCaptureContext(canvas);
    if (!audioRoutingRef.current) audioRoutingRef.current = attachAudioRouting(video);
    const audioCapture = captureAudioForRecording(audioRoutingRef.current);
    const stream = new MediaStream([
      ...captureCtx.videoStream.getVideoTracks(),
      ...audioCapture.tracks,
    ]);
    const bitrate = pickBitrate(video.videoWidth, video.videoHeight);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: candidate.mime || undefined,
        videoBitsPerSecond: bitrate,
      });
    } catch (e) {
      audioCapture.cleanup();
      recordingFlagRef.current = false;
      setError("Recording failed: " + (e instanceof Error ? e.message : String(e)));
      startPreview();
      return;
    }

    recorderRef.current = recorder;
    audioCleanupRef.current = audioCapture.cleanup;
    const sink = await createRecordingSink(AQUA_FIX_BRAND.opfsPrefix);
    sinkRef.current = sink;
    let writeQueue: Promise<void> = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      writeQueue = writeQueue.then(() => sink.write(e.data)).catch(() => undefined);
    };
    recorder.onerror = (e: Event) => {
      const evt = e as Event & { error?: unknown };
      const msg = evt.error instanceof Error ? evt.error.message : "encoder error";
      setError("Recording error: " + msg);
    };

    lastStatsRefreshRef.current = 0;
    const renderAndPush = () => {
      if (!recordingFlagRef.current || !rendererRef.current || !statsRef.current || !videoRef.current) return;
      const v = videoRef.current;
      maybeRefreshStats(v);
      rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
      const eff = showOriginalRef.current ? OFF_SETTINGS : settingsRef.current;
      rendererRef.current.render(statsRef.current, eff);
      setRecordTime(v.currentTime);
      if (v.duration) setRecordProgress(v.currentTime / v.duration);
    };

    const loop = () => {
      if (!recordingFlagRef.current) return;
      renderAndPush();
      if (!video.ended && recordingFlagRef.current) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    const stopAndDownload = () =>
      new Promise<void>((resolve) => {
        recorder.onstop = async () => {
          audioCapture.cleanup();
          audioCleanupRef.current = null;
          try {
            await writeQueue;
            const blob = await sink.finalize(candidate.mime || "video/webm");
            await shareOrDownload(blob, `${fileNameRef.current}-aqua.${candidate.ext}`);
          } catch (err) {
            setError("Save failed: " + (err instanceof Error ? err.message : String(err)));
          } finally {
            await sink.cleanup();
            sinkRef.current = null;
            resolve();
          }
        };
        try {
          recorder.stop();
        } catch {
          audioCapture.cleanup();
          audioCleanupRef.current = null;
          sink.cleanup().finally(() => {
            sinkRef.current = null;
            resolve();
          });
        }
      });

    const onEnded = async () => {
      recordingFlagRef.current = false;
      onEndedRef.current = null;
      video.removeEventListener("ended", onEnded);
      await stopAndDownload();
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch {
          // ignore
        }
        wakeLockRef.current = null;
      }
      setRecording(false);
      setRecordProgress(0);
      setRecordTime(0);
      video.loop = true;
      video.muted = true;
      try {
        video.currentTime = 0;
      } catch {
        // ignore
      }
      await video.play().catch(() => undefined);
      startPreview();
    };
    onEndedRef.current = onEnded;
    video.addEventListener("ended", onEnded);

    setRecording(true);
    setRecordProgress(0);
    setRecordTime(0);
    recorder.start(1000);
    try {
      await video.play();
    } catch (e) {
      recordingFlagRef.current = false;
      audioCapture.cleanup();
      audioCleanupRef.current = null;
      try {
        recorder.stop();
      } catch {
        // ignore
      }
      try {
        await sink.cleanup();
      } catch {
        // ignore
      }
      sinkRef.current = null;
      setRecording(false);
      setError("Couldn't start playback for recording: " + (e instanceof Error ? e.message : String(e)));
      startPreview();
    }
  }

  function cancelRecording() {
    recordingFlagRef.current = false;
    const v = videoRef.current;
    if (v && onEndedRef.current) {
      v.removeEventListener("ended", onEndedRef.current);
      onEndedRef.current = null;
    }
    if (v) v.pause();
    if (recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      try {
        if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
      } catch {
        // ignore
      }
      recorderRef.current = null;
    }
    if (audioCleanupRef.current) {
      audioCleanupRef.current();
      audioCleanupRef.current = null;
    }
    if (sinkRef.current) {
      sinkRef.current.cleanup().catch(() => undefined);
      sinkRef.current = null;
    }
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
    }
    setRecording(false);
    setRecordProgress(0);
    setRecordTime(0);
    if (v) {
      v.loop = true;
      v.muted = true;
      try {
        v.currentTime = 0;
      } catch {
        // ignore
      }
      v.play().catch(() => undefined);
    }
    startPreview();
  }

  return (
    <div className="app">
      <div className="bg" aria-hidden="true" />

      <Hero logo={<AquaFixLogo />} name={AQUA_FIX_BRAND.name} tagline={AQUA_FIX_BRAND.tagline} />

      <div
        className={`stage ${mode === "idle" ? "is-empty" : ""}`}
        onClick={(e) => {
          if (mode !== "video" || recording) return;
          if ((e.target as HTMLElement).closest("button")) return;
          togglePlay();
        }}
      >
        <canvas ref={canvasRef} />
        <video ref={videoRef} style={{ display: "none" }} />
        {mode === "idle" && <PlaceholderDropZone accept="image/*,video/*" onPick={handleFile} />}
        {error && <div className="error">{error}</div>}
        {busy && <BusyOverlay message={busy} />}
        {recording && (
          <RecordingOverlay currentTime={recordTime} duration={duration} progress={recordProgress} />
        )}
        {mode === "video" && isPaused && !recording && <PlayOverlay />}
        {mode !== "idle" && !recording && (
          <CompareButton
            active={showOriginal}
            onPress={() => setShowOriginal(true)}
            onRelease={() => setShowOriginal(false)}
          />
        )}
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
        <FilePickerButton accept="image/*,video/*" disabled={recording} onPick={handleFile}>
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
          Pick photo or video
        </FilePickerButton>

        {mode !== "idle" && (
          <>
            <PresetsRow
              presets={PRESETS}
              current={settings}
              matches={matchesPreset}
              onSelect={setSettings}
              disabled={recording}
            />

            <div className="sliders">
              <Slider label="Intensity" value={settings.intensity} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, intensity: v }))} disabled={recording} />
              <Slider label="Cast removal" value={settings.castStrength} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, castStrength: v }))} disabled={recording} />
              <Slider label="Saturation" value={settings.saturation} min={0} max={2} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, saturation: v }))} disabled={recording} />
            </div>

            <AdvancedDisclosure disabled={recording}>
              <div className="lut-row">
                <label className="lut-pick">
                  <input
                    type="file"
                    accept=".cube,application/octet-stream,text/plain"
                    disabled={recording}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleLUTFile(f);
                      e.target.value = "";
                    }}
                  />
                  <span>{lutName ? "Replace LUT" : "Load Lightroom .cube LUT"}</span>
                </label>
                {lutName && (
                  <button className="lut-clear" onClick={clearLUT} aria-label="Remove LUT">×</button>
                )}
              </div>
              {lutName && <p className="lut-name" title={lutName}>{lutName}</p>}
              <Slider label="LUT mix" value={settings.lutMix} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, lutMix: v }))} disabled={recording || !lutName} />
              <Slider label="CLAHE" value={settings.clahe} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, clahe: v }))} disabled={recording} />
              <Slider label="Gamma" value={settings.gamma} min={0.5} max={1.5} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, gamma: v }))} disabled={recording} />
              <Slider label="Contrast" value={settings.contrast} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, contrast: v }))} disabled={recording} />
            </AdvancedDisclosure>

            <div className="actions">
              <button className="ghost" onClick={() => setSettings(DEFAULT_SETTINGS)} disabled={recording}>
                Reset
              </button>
              {mode === "photo" && (
                <button className="primary" onClick={savePhoto}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 19h14M12 4v11M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2"
                      fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
                <button className="danger" onClick={cancelRecording}>Cancel</button>
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

function lerpStats(a: Stats, b: Stats, t: number): Stats {
  const mix = (x: number, y: number) => x * (1 - t) + y * t;
  const mix3 = (
    p: [number, number, number],
    q: [number, number, number],
  ): [number, number, number] => [mix(p[0], q[0]), mix(p[1], q[1]), mix(p[2], q[2])];
  const lutOut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256 * 4; i++) {
    lutOut[i] = Math.round(a.toneLUT[i] * (1 - t) + b.toneLUT[i] * t);
  }
  return {
    mean: mix3(a.mean, b.mean),
    wbGain: mix3(a.wbGain, b.wbGain),
    min: mix3(a.min, b.min),
    max: mix3(a.max, b.max),
    alpha: b.alpha,
    toneLUT: lutOut,
  };
}

function matchesPreset(a: Settings, b: Settings, eps = 0.01) {
  return (
    Math.abs(a.intensity - b.intensity) < eps &&
    Math.abs(a.castStrength - b.castStrength) < eps &&
    Math.abs(a.saturation - b.saturation) < eps &&
    Math.abs(a.gamma - b.gamma) < eps &&
    Math.abs(a.contrast - b.contrast) < eps &&
    Math.abs(a.clahe - b.clahe) < eps
  );
}
