import { useEffect, useRef, useState } from "react";
import {
  AdvancedDisclosure,
  attachAudioRouting,
  bitrateFromSource,
  buildCaptureContext,
  BusyOverlay,
  captureAudioForRecording,
  closeAudioRouting,
  CompareWipe,
  createRecordingSink,
  detectVideoFps,
  FilePickerButton,
  touchFile,
  validateUploadedFile,
  Hero,
  Modal,
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
import { isFunieCached, isFunieReady, loadFunie, FUNIE_SIZE_MB } from "./lib/funie-loader";
import { LoadAbortedError } from "@dive-tools/shared";
import { runFunie, lerpTransferToIdentity } from "./lib/funie-runner";

type Mode = "idle" | "photo" | "video";
type Quality = "classical" | "ai";

// Defaults retuned against bornfree/dive-color-corrector's constants
// (MIN_AVG_RED=60, BLUE_MAGIC_VALUE=1.2, THRESHOLD_RATIO=2000) and the
// Ancuti 2018 fusion-input recipe (gamma-corrected branch ≈ 0.9–0.95).
const SHALLOW_SETTINGS: Settings = {
  intensity: 0.55,
  castStrength: 0.35,
  saturation: 1.10,
  gamma: 1.00,
  contrast: 0.20,
  clahe: 0.15,
  lutMix: 1.0,
};

// Reef preset — heavier red-channel push, suitable for typical 5–15 m
// reef shots where the cyan cast is pronounced but reds aren't fully
// gone. Used to be the default; Shallow now is, because Reef pushes
// some shots into oversaturated cyan-white highlights.
const REEF_SETTINGS: Settings = {
  intensity: 0.85,
  castStrength: 0.65,
  saturation: 1.25,
  gamma: 0.92,
  contrast: 0.35,
  clahe: 0.35,
  lutMix: 1.0,
};

const DEEP_SETTINGS: Settings = {
  intensity: 1.00,
  castStrength: 0.90,
  saturation: 1.40,
  gamma: 0.80,
  contrast: 0.45,
  clahe: 0.55,
  lutMix: 1.0,
};

// Default = Shallow. Most divers shoot in the 0–10 m range where reds
// are mostly intact, so a light correction gets closer to what the
// scene looked like in person without the over-corrected cyan-white
// blowouts the Reef preset can produce on bright shallow shots.
const DEFAULT_SETTINGS: Settings = SHALLOW_SETTINGS;

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

// Shallow / Reef / Deep values from the research synthesis above —
// Shallow scales red compensation low (0–10 m, reds mostly intact);
// Reef matches bornfree's auto-correction defaults (5–15 m); Deep
// pushes near-max cast removal (>15 m, reds largely lost per TDI/SDI
// guidance).
const PRESETS: { label: string; settings: Settings }[] = [
  { label: "Off", settings: OFF_SETTINGS },
  { label: "Shallow", settings: SHALLOW_SETTINGS },
  { label: "Reef", settings: REEF_SETTINGS },
  { label: "Deep", settings: DEEP_SETTINGS },
];

type AudioRouting = ReturnType<typeof attachAudioRouting>;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const statsRef = useRef<Stats | null>(null);
  const imageBitmapRef = useRef<ImageBitmap | null>(null);
  const fileNameRef = useRef<string>(AQUA_FIX_BRAND.filenamePrefix);
  // URL.createObjectURL of the current source file. Tracked so we can
  // revoke it on teardown / next load instead of leaking blob URLs (and
  // the underlying decoded bytes) for every video the user opens.
  const sourceUrlRef = useRef<string | null>(null);
  // Source-video properties detected on load. Used to record at the same
  // fps + bitrate as the input so we don't lose smoothness or quality.
  const sourceFpsRef = useRef<number>(60);
  const sourceBitrateRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const previewActiveRef = useRef(false);
  const recordingFlagRef = useRef(false);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const audioRoutingRef = useRef<AudioRouting>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const onEndedRef = useRef<(() => void) | null>(null);
  const sinkRef = useRef<RecordingSink | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockListenerRef = useRef<(() => void) | null>(null);
  const loadCanPlayListenerRef = useRef<(() => void) | null>(null);
  const lastStatsRefreshRef = useRef(0);
  // Tracks whether statsRef holds a real (lerped) stat value. Was being
  // detected via `cur !== IDENTITY_STATS` which only catches the *first*
  // replacement — subsequent file loads that reset to IDENTITY would not
  // re-snap because the equality check was on object identity, not on a
  // reset signal.
  const statsRealRef = useRef(false);
  // Dynamic grading: when on, recompute white-balance / mean / min-max
  // stats per ~250 ms and lerp into the current stats. When off, the
  // first-frame stats stay frozen for the whole clip — picks the look
  // from the opening shot and never re-balances. Off by default because
  // dynamic re-grading can lurch when a fish swims in or the camera
  // pans into a different colour zone, turning a good frame red. Live
  // ref so the per-frame loop reads the latest value without rebinding.
  const dynamicGradeRef = useRef(false);
  const [dynamicGrade, setDynamicGrade] = useState(false);
  useEffect(() => { dynamicGradeRef.current = dynamicGrade; }, [dynamicGrade]);

  const [mode, setMode] = useState<Mode>("idle");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // Compare-wipe state. compareActive shows the slider overlay; split is
  // 0..1 (0 = whole frame original; 1 = whole frame corrected). Split
  // value is pushed to the renderer per-frame so the WebGL shader can
  // do the divide.
  const [compareActive, setCompareActive] = useState(false);
  const [compareSplit, setCompareSplit] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordTime, setRecordTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [canRecord, setCanRecord] = useState(true);
  const [lutName, setLutName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  // AI is experimental — always start in classical, even if a previous
  // session had AI selected. The user has to opt in each time, which is
  // also why the prompt only fires on AI-button click (not on file pick).
  const [quality, setQuality] = useState<Quality>("classical");
  const [funieReady, setFunieReady] = useState(isFunieReady());
  const [funieDownloadPct, setFunieDownloadPct] = useState<number | null>(null);
  const [showFuniePrompt, setShowFuniePrompt] = useState(false);
  // Bumped on every file load. Async work in flight (AI inference,
  // detectVideoFps, runFunie .then callbacks) reads this at the start
  // and bails if it changed, so completing inferences for a stale file
  // can't clobber the new file's render or stats.
  const fileGenRef = useRef(0);
  // rAF id for the entry slider animation. Cancel on next file load /
  // unmount so two animations don't fight for the settings state.
  const entryAnimRef = useRef<number | null>(null);
  // Auto-animated split during the entry reveal. When non-null, the
  // renderer reads this instead of the manual compareSplit, so the
  // wipe slides without us having to flip compareActive on (which
  // would block click-to-pause and show the manual handle UI).
  const entryAnimSplitRef = useRef<number | null>(null);
  // AbortController for the in-flight model download. Lets the user
  // bail out via the dialog's Cancel button without waiting for the
  // full ~17 MB to finish (especially useful on flaky connections).
  const funieAbortRef = useRef<AbortController | null>(null);
  // True while a load is in flight (cached or downloading). Without
  // this a fast double-tap on the AI card fires two parallel
  // loadFunie() calls and races their completions.
  const funieLoadingRef = useRef(false);
  // True once we've confirmed the model bytes are in Cache API. Probed
  // once on mount; if true, clicking the AI card skips the consent
  // dialog entirely (just decodes from cache and switches mode).
  const [funieCached, setFunieCached] = useState(false);
  useEffect(() => {
    isFunieCached().then(setFunieCached).catch(() => undefined);
  }, []);
  // Mirror of funieReady — the play-loop captures its closure once at
  // startPreview() and never re-binds, so reading the state directly
  // would forever see the value at preview-start time. Reading via the
  // ref always sees the latest.
  const funieReadyRef = useRef(funieReady);
  useEffect(() => {
    funieReadyRef.current = funieReady;
  }, [funieReady]);
  const [aiStrength, setAiStrength] = useState(() => {
    const v = parseFloat(localStorage.getItem("aqua-fix:aiStrength") || "1");
    return isNaN(v) ? 1 : Math.min(1, Math.max(0, v));
  });
  const aiStrengthRef = useRef(aiStrength);
  const qualityRef = useRef<Quality>(quality);
  useEffect(() => {
    qualityRef.current = quality;
  }, [quality]);
  useEffect(() => {
    aiStrengthRef.current = aiStrength;
    localStorage.setItem("aqua-fix:aiStrength", aiStrength.toString());
  }, [aiStrength]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Push the wipe split into the renderer whenever it changes. Renderer
  // holds the value so per-frame draws (preview + recording) pick it up
  // without needing to thread it through every render call. The entry
  // animation overrides via entryAnimSplitRef.
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSplit(
        entryAnimSplitRef.current ?? (compareActive ? compareSplit : 0),
      );
    }
  }, [compareActive, compareSplit]);

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
    if (qualityRef.current === "ai" && funieReady) {
      // Photos: run AI once at full quality, draw the model output
      // directly. Capture the file generation now and bail if a new
      // file has been picked by the time inference completes — without
      // this guard the stale inference's then() would clobber the new
      // file's already-rendered frame.
      const myGen = fileGenRef.current;
      runFunie(bitmap, aiStrengthRef.current)
        .then((res) => {
          if (myGen !== fileGenRef.current) return;
          if (!rendererRef.current) return;
          rendererRef.current.uploadSource(res.canvas, bitmap.width, bitmap.height);
          rendererRef.current.render(IDENTITY_STATS, OFF_SETTINGS);
        })
        .catch((e) => setError("AI inference failed: " + (e instanceof Error ? e.message : String(e))));
      return;
    }
    rendererRef.current.uploadSource(bitmap, bitmap.width, bitmap.height);
    rendererRef.current.render(statsRef.current, settings);
  }, [settings, mode, funieReady, quality, aiStrength]);

  useEffect(() => {
    if (mode !== "video" || !videoRef.current || videoRef.current.readyState < 2) return;
    const v = videoRef.current;
    statsRef.current = computeStats(v, v.videoWidth, v.videoHeight, settings.castStrength);
  }, [settings.castStrength, mode]);

  const aiInflightRef = useRef(false);
  // Cached colour transfer (gain * src + bias) from the most recent FUnIE
  // inference. Each inference EMA-blends into this ref instead of
  // replacing it — without smoothing the model fits new gain/bias to
  // every frame's content (particles, scene movement) and the wholesale
  // swap shows up as visible flicker / flaring at 5–10 fps. 25% per
  // inference settles in ~4 inferences while still tracking real scene
  // changes within a fraction of a second.
  const aiTransferRef = useRef<{ gain: [number, number, number]; bias: [number, number, number] }>({
    gain: [1, 1, 1],
    bias: [0, 0, 0],
  });
  const aiTransferInitialisedRef = useRef(false);
  const AI_TRANSFER_SMOOTH = 0.25;

  function renderFrameSync(v: HTMLVideoElement) {
    if (!rendererRef.current || !statsRef.current) return;
    if (qualityRef.current === "ai" && funieReadyRef.current) {
      // Always upload the current frame and apply the cached AI transfer at
      // full FPS. The model runs in the background — no render-frame is
      // gated on inference, so playback stays smooth even when inference
      // takes 100+ ms per frame. Strength is lerped toward identity at
      // render time so the slider takes effect on the very next render
      // (no need to wait for the next inference).
      rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
      const t = lerpTransferToIdentity(aiTransferRef.current, aiStrengthRef.current);
      rendererRef.current.renderAi(t.gain, t.bias);
      // Kick off a fresh inference if none in flight — refreshes the
      // transfer from the current frame's content.
      if (!aiInflightRef.current) {
        aiInflightRef.current = true;
        const myGen = fileGenRef.current;
        runFunie(v, aiStrengthRef.current)
          .then((res) => {
            // Bail if a new file replaced this one mid-inference —
            // otherwise the stale transfer EMA-blends into the new
            // file's cache.
            if (myGen !== fileGenRef.current) return;
            const prev = aiTransferRef.current;
            const init = aiTransferInitialisedRef.current;
            // First inference snaps in; subsequent inferences EMA-blend
            // so transient particle-driven jitter doesn't show up as
            // visible flicker.
            const a = init ? AI_TRANSFER_SMOOTH : 1;
            aiTransferRef.current = {
              gain: [
                prev.gain[0] + (res.transfer.gain[0] - prev.gain[0]) * a,
                prev.gain[1] + (res.transfer.gain[1] - prev.gain[1]) * a,
                prev.gain[2] + (res.transfer.gain[2] - prev.gain[2]) * a,
              ],
              bias: [
                prev.bias[0] + (res.transfer.bias[0] - prev.bias[0]) * a,
                prev.bias[1] + (res.transfer.bias[1] - prev.bias[1]) * a,
                prev.bias[2] + (res.transfer.bias[2] - prev.bias[2]) * a,
              ],
            };
            aiTransferInitialisedRef.current = true;
            // On paused video the play loop isn't redrawing — force a
            // re-render here so the just-computed transfer is visible
            // immediately. Without this, switching Classical→AI on a
            // paused frame would show identity (the initial transfer)
            // forever until the user pressed play.
            const vv = videoRef.current;
            if (vv && vv.paused && rendererRef.current && qualityRef.current === "ai") {
              rendererRef.current.uploadSource(vv, vv.videoWidth, vv.videoHeight);
              const tt = lerpTransferToIdentity(aiTransferRef.current, aiStrengthRef.current);
              rendererRef.current.renderAi(tt.gain, tt.bias);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            aiInflightRef.current = false;
          });
      }
      return;
    }
    rendererRef.current.uploadSource(v, v.videoWidth, v.videoHeight);
    rendererRef.current.render(statsRef.current, settingsRef.current);
  }

  const { currentTime, isPaused } = useVideoPlaybackState(videoRef, mode === "video", () => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) return;
    renderFrameSync(v);
  });

  // Repaint the frozen frame when settings change while paused.
  useEffect(() => {
    if (mode !== "video") return;
    const v = videoRef.current;
    if (!v || v.readyState < 2) return;
    if (!v.paused) return;
    renderFrameSync(v);
  }, [settings, isPaused, mode, funieReady, quality, aiStrength]);

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
    // Dynamic grading off → keep the first-frame stats frozen for
    // the whole clip. statsRef is set once in loadVideo and we just
    // leave it alone here.
    if (!dynamicGradeRef.current) return;
    const now = performance.now();
    // Refresh 4× per second instead of 1× — combined with a per-step
    // lerp 4× smaller, the effective time constant matches the previous
    // 1 Hz × 15% setup, but each visible step is 4× smaller. Eliminates
    // the once-per-second pulse that showed as a flicker, especially on
    // footage with drifting particles where stats wobble slightly.
    if (now - lastStatsRefreshRef.current < 250) return;
    if (video.readyState < 2) return;
    try {
      const fresh = computeStats(video, video.videoWidth, video.videoHeight, settingsRef.current.castStrength);
      const cur = statsRef.current;
      if (cur && statsRealRef.current) {
        statsRef.current = lerpStats(cur, fresh, 0.0375);
      } else {
        statsRef.current = fresh;
        statsRealRef.current = true;
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
      const v = videoRef.current;
      if (!v || v.readyState < 2) return;
      maybeRefreshStats(v);
      renderFrameSync(v);
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
      // Remove the canplay listener if it never fired — otherwise it'd
      // attach to the next file's load and run a stale closure.
      if (loadCanPlayListenerRef.current) {
        videoRef.current.removeEventListener("canplay", loadCanPlayListenerRef.current);
        loadCanPlayListenerRef.current = null;
      }
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
    // Revoke the previous file's blob URL — without this every uploaded
    // file leaked its decoded bytes for the rest of the session.
    if (sourceUrlRef.current) {
      try { URL.revokeObjectURL(sourceUrlRef.current); } catch { /* ignore */ }
      sourceUrlRef.current = null;
    }
    // Tear down the audio routing attached to the previous video element.
    // iOS Safari throws on the second createMediaElementSource for the
    // same element, and the AudioContext leaked across files even where
    // it didn't throw.
    if (audioRoutingRef.current) {
      closeAudioRouting(audioRoutingRef.current);
      audioRoutingRef.current = null;
    }
  }

  const pendingFileRef = useRef<File | null>(null);

  // Animate the compare-wipe split on initial reveal so the user
  // sees a clear before→after slide: hold full original (split=1) for
  // ~400 ms, then sweep split 1 → 0 over 2.2 s (ease-in-out cubic).
  // Drives the renderer directly via entryAnimSplitRef instead of
  // flipping compareActive on — the latter would show the manual
  // wipe handle UI AND block click-to-pause on the stage.
  function animateEntrySettings() {
    if (entryAnimRef.current !== null) {
      cancelAnimationFrame(entryAnimRef.current);
      entryAnimRef.current = null;
    }
    const HOLD_MS = 800;
    const SLIDE_MS = 4400;
    const apply = (v: number) => {
      entryAnimSplitRef.current = v;
      // Push the value through the renderer immediately. The per-frame
      // preview loop also reads this on its next tick — but for paused
      // frames (photos, or video before play()) we need to redraw now.
      const r = rendererRef.current;
      if (r) {
        r.setSplit(v);
        if (statsRef.current && imageBitmapRef.current && mode === "photo") {
          r.render(statsRef.current, settingsRef.current);
        }
      }
    };
    apply(1);
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = now - start;
      if (elapsed < HOLD_MS) {
        apply(1);
        entryAnimRef.current = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, (elapsed - HOLD_MS) / SLIDE_MS);
      // Ease-in-out cubic — accelerate through the middle of the frame
      // (where the contrast is most visible) and decelerate at the
      // ends so start/finish feel intentional.
      const e = t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
      apply(1 - e);
      if (t < 1) {
        entryAnimRef.current = requestAnimationFrame(tick);
      } else {
        entryAnimRef.current = null;
        entryAnimSplitRef.current = null;
        // Hand control back to the manual compare wipe state.
        if (rendererRef.current) {
          rendererRef.current.setSplit(compareActive ? compareSplit : 0);
        }
      }
    };
    entryAnimRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      if (entryAnimRef.current !== null) cancelAnimationFrame(entryAnimRef.current);
    };
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setRecording(false);
    setRecordProgress(0);
    const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
    const validation = validateUploadedFile(file, isVideo ? "video" : "image");
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    teardownVideo();
    fileGenRef.current++;
    fileNameRef.current = file.name.replace(/\.[^.]+$/, "");
    sourceFpsRef.current = 60;
    sourceBitrateRef.current = null;
    // Reset the AI transfer cache so the new file's first inference
    // snaps in (instead of EMA-blending from the previous video's
    // colour stats, which would look wrong for several seconds).
    aiTransferRef.current = { gain: [1, 1, 1], bias: [0, 0, 0] };
    aiTransferInitialisedRef.current = false;
    // Same idea for the classical stats: force the first refresh to
    // snap in instead of lerping from the previous file's mean/wbGain.
    statsRealRef.current = false;
    setBusy(isVideo ? "Loading video…" : "Loading photo…");
    try {
      // Touch the file's first byte before we hand it to <video> /
      // createImageBitmap. On iOS, items from "Recently Saved" can be
      // iCloud placeholders that the picker hands over before the bytes
      // are local — touching here either coaxes the download or surfaces
      // a clean error before the heavier load path swallows it.
      await touchFile(file);
      if (isVideo) {
        sourceBitrateRef.current = bitrateFromSource(file.size, 0);
        await loadVideo(file);
      } else {
        await loadImage(file);
      }
      animateEntrySettings();
    } finally {
      setBusy(null);
    }
  }

  async function confirmFunieDownloadAndProceed() {
    setShowFuniePrompt(false);
    setFunieDownloadPct(0);
    const ctrl = new AbortController();
    funieAbortRef.current = ctrl;
    try {
      await loadFunie((pct) => setFunieDownloadPct(pct), ctrl.signal);
      setFunieReady(true);
      setFunieCached(true);
      setFunieDownloadPct(null);
      setQuality("ai");
    } catch (e) {
      setFunieDownloadPct(null);
      if (!(e instanceof LoadAbortedError)) {
        setError("Couldn't load AI model: " + (e instanceof Error ? e.message : String(e)));
      }
    } finally {
      funieAbortRef.current = null;
    }
  }

  function cancelFunieDownload() {
    funieAbortRef.current?.abort();
  }

  // Cached path: load silently (no dialog, no progress bar) and switch
  // straight to AI. Decoding 17 MB from the local cache + building the
  // ort session takes a handful of frames at most.
  async function loadFunieFromCacheAndSwitch() {
    if (funieLoadingRef.current) return;
    funieLoadingRef.current = true;
    try {
      await loadFunie();
      setFunieReady(true);
      setQuality("ai");
    } catch (e) {
      setError("Couldn't load AI model: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      funieLoadingRef.current = false;
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
        rendererRef.current.render(statsRef.current, settings);
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
      rendererRef.current.render(statsRef.current, settings);
    }
  }

  async function loadImage(file: File) {
    try {
      // imageOrientation: "from-image" honours the JPEG's EXIF
      // Orientation tag. Without it iOS Safari renders portrait iPhone
      // photos rotated 90° (the camera shoots in landscape but tags
      // them with the rotation in EXIF). Some older browsers ignore
      // the option silently, which is fine — they were already
      // rendering whatever orientation they pleased.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
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
    sourceUrlRef.current = url;
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

      // Recompute the source bitrate now that we have a reliable duration,
      // and detect fps from the actual frame stream. Both are used by the
      // recording flow so the saved file matches the input's smoothness
      // and quality ceiling.
      sourceBitrateRef.current = bitrateFromSource(file.size, video.duration || 0);
      const myGen = fileGenRef.current;
      detectVideoFps(video).then((fps) => {
        if (myGen !== fileGenRef.current) return;
        sourceFpsRef.current = Math.max(24, fps);
      }).catch(() => undefined);

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
          loadCanPlayListenerRef.current = null;
          computeOnce();
        };
        // Track the listener so teardownVideo can remove it. Without
        // this, a teardown-before-canplay leaves the old listener
        // attached and the next file's first canplay fires the stale
        // closure.
        if (loadCanPlayListenerRef.current) {
          video.removeEventListener("canplay", loadCanPlayListenerRef.current);
        }
        loadCanPlayListenerRef.current = onCanPlay;
        video.addEventListener("canplay", onCanPlay);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function savePhoto() {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    const bitmap = imageBitmapRef.current;
    if (!canvas || !renderer || !bitmap) return;
    // Disable the wipe for the saved file even if it's currently on.
    const prevSplit = renderer;
    renderer.setSplit(0);
    try {
      // Re-render synchronously before toBlob — the WebGL context is
      // created without preserveDrawingBuffer so the backbuffer may have
      // been cleared since the last paint.
      if (qualityRef.current === "ai" && funieReadyRef.current) {
        // Critical: the previous version of this function always called
        // the classical render even in AI mode, so the saved photo
        // showed a *different* result from what the user was seeing on
        // screen. Run the model and render its output.
        const res = await runFunie(bitmap, aiStrengthRef.current);
        renderer.uploadSource(res.canvas, bitmap.width, bitmap.height);
        renderer.render(IDENTITY_STATS, OFF_SETTINGS);
      } else if (statsRef.current) {
        renderer.uploadSource(bitmap, bitmap.width, bitmap.height);
        renderer.render(statsRef.current, settings);
      }
      await new Promise<void>((resolve) => {
        canvas.toBlob(
          (blob) => {
            if (blob) shareOrDownload(blob, `${fileNameRef.current}-aqua.jpg`).catch(() => undefined);
            resolve();
          },
          "image/jpeg",
          0.95,
        );
      });
    } finally {
      // Restore wipe split so the on-screen view goes back to what
      // the user had set (or the entry animation if still running).
      void prevSplit;
      renderer.setSplit(
        entryAnimSplitRef.current ?? (compareActive ? compareSplit : 0),
      );
    }
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
      // Wake lock was acquired in recordVideoInner before this throw —
      // the success/cancel paths release it but the outer catch was
      // missing the call, leaking the lock for the rest of the session.
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => undefined);
        wakeLockRef.current = null;
        if (wakeLockListenerRef.current) {
          document.removeEventListener("visibilitychange", wakeLockListenerRef.current);
          wakeLockListenerRef.current = null;
        }
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
    // Disable the compare wipe before recording — otherwise the saved
    // file is split (original on left, corrected on right) which is
    // never what the user wants in their final video.
    if (compareActive) {
      setCompareActive(false);
      rendererRef.current?.setSplit(0);
    }

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
    const requestWakeLock = () => {
      if (!wakeLockApi || typeof wakeLockApi.request !== "function") return;
      wakeLockApi
        .request("screen")
        .then((lock) => {
          // Late-arrival guard: if the recording already finished or
          // was cancelled before the promise resolved, release the
          // lock immediately so it doesn't leak for the rest of the
          // session.
          if (!recordingFlagRef.current) {
            lock.release().catch(() => undefined);
            return;
          }
          wakeLockRef.current = lock;
        })
        .catch(() => undefined);
    };
    requestWakeLock();
    // iOS auto-releases the wake-lock sentinel when the tab is
    // backgrounded; re-request on visibility return so a long
    // recording resumed from lock screen still keeps the screen on.
    const onVisibility = () => {
      if (document.visibilityState === "visible" && recordingFlagRef.current && !wakeLockRef.current) {
        requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    wakeLockListenerRef.current = onVisibility;

    if (rendererRef.current) {
      rendererRef.current.uploadSource(video, video.videoWidth, video.videoHeight);
      rendererRef.current.render(statsRef.current, settingsRef.current);
    }

    const fps = sourceFpsRef.current;
    const captureCtx = buildCaptureContext(canvas, fps);
    if (!audioRoutingRef.current) audioRoutingRef.current = attachAudioRouting(video);
    const audioCapture = await captureAudioForRecording(audioRoutingRef.current);
    const stream = new MediaStream([
      ...captureCtx.videoStream.getVideoTracks(),
      ...audioCapture.tracks,
    ]);
    // Match the source bitrate when we can; otherwise fall back to a
    // pixel/fps formula that still hits visually-lossless quality.
    const bitrate = sourceBitrateRef.current
      ?? pickBitrate(video.videoWidth, video.videoHeight, fps);

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
    let lastUiPushAt = 0;
    const renderAndPush = () => {
      if (!recordingFlagRef.current || !videoRef.current) return;
      const v = videoRef.current;
      maybeRefreshStats(v);
      renderFrameSync(v);
      // Throttle React state updates to ~4 Hz; the rAF loop fires
      // ~60 Hz but the recording overlay only needs to tick on a
      // human-readable cadence. Avoids re-committing the component
      // and re-running effects every frame during a long recording.
      const now = performance.now();
      if (now - lastUiPushAt > 250) {
        lastUiPushAt = now;
        setRecordTime(v.currentTime);
        if (Number.isFinite(v.duration) && v.duration > 0) setRecordProgress(v.currentTime / v.duration);
      }
    };

    // Drive renders from requestVideoFrameCallback when available so
    // we capture exactly one canvas frame per decoded video frame.
    // The previous rAF loop ran at display refresh (~60Hz) regardless
    // of whether the video advanced — heavy 4K clips produced saved
    // files with stretches of frozen video. rAF fallback for browsers
    // without rVFC. The chain is restartable so the stall watchdog
    // can re-register it after a play() resume (rVFC chain dies when
    // the video pauses, since the last callback never fires).
    const useRvfc = typeof video.requestVideoFrameCallback === "function";
    let rvfcChainAlive = false;
    const startRvfcChain = () => {
      if (!useRvfc || rvfcChainAlive) return;
      rvfcChainAlive = true;
      const onFrame = () => {
        rvfcChainAlive = true;
        if (!recordingFlagRef.current) return;
        renderAndPush();
        if (!video.ended && recordingFlagRef.current) {
          video.requestVideoFrameCallback?.(onFrame);
        } else {
          rvfcChainAlive = false;
        }
      };
      video.requestVideoFrameCallback?.(onFrame);
    };
    if (useRvfc) {
      startRvfcChain();
    } else {
      const loop = () => {
        if (!recordingFlagRef.current) return;
        renderAndPush();
        if (!video.ended && recordingFlagRef.current) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    // Stall detector: 5 s polling, single-strike — try a play() resume
    // immediately and re-arm the rVFC chain. Surfaces an error only if
    // play() rejects (truly dead decoder). Aggressive cadence because
    // the prior 10 s × 2-strike (20 s effective) was longer than the
    // user's tolerance — they reported a freeze at 28 s and the
    // saved file kept duplicating that frame for many seconds before
    // anything noticed.
    let recordingStallLastTime = 0;
    const stallWatchdog = window.setInterval(() => {
      if (!recordingFlagRef.current) {
        clearInterval(stallWatchdog);
        return;
      }
      if (document.visibilityState !== "visible") {
        recordingStallLastTime = video.currentTime;
        return;
      }
      if (video.currentTime <= recordingStallLastTime + 0.1 && !video.ended) {
        // Stalled — try resume.
        console.warn(`[record] video stalled at ${video.currentTime.toFixed(2)}s — attempting play()`);
        video.play().then(() => {
          // Re-arm rVFC since the old chain died when the video paused.
          rvfcChainAlive = false;
          startRvfcChain();
        }).catch(() => {
          setError("Recording stalled — exported video may be incomplete.");
        });
      }
      recordingStallLastTime = video.currentTime;
    }, 5000);

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
      if (wakeLockListenerRef.current) {
        document.removeEventListener("visibilitychange", wakeLockListenerRef.current);
        wakeLockListenerRef.current = null;
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
    // Start playback FIRST so an autoplay rejection doesn't leave the
    // recorder running with no frames (which previously produced a
    // 0-byte .tmp file in OPFS that lingered for 60s).
    try {
      await video.play();
    } catch (e) {
      recordingFlagRef.current = false;
      audioCapture.cleanup();
      audioCleanupRef.current = null;
      try {
        await sink.cleanup();
      } catch {
        // ignore
      }
      sinkRef.current = null;
      setRecording(false);
      setError("Couldn't start playback for recording: " + (e instanceof Error ? e.message : String(e)));
      startPreview();
      return;
    }
    recorder.start(1000);
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

      <Hero
        logo={<AquaFixLogo />}
        name={AQUA_FIX_BRAND.name}
        tagline={AQUA_FIX_BRAND.tagline}
        onInfoClick={() => setShowInfo(true)}
      />
      <Modal
        open={showFuniePrompt}
        onClose={() => {
          setShowFuniePrompt(false);
          pendingFileRef.current = null;
        }}
        title={`Download AI model (~${FUNIE_SIZE_MB.toFixed(0)} MB)`}
      >
        <p>
          AI mode uses{" "}
          <a href="https://arxiv.org/abs/1903.09766" target="_blank" rel="noopener noreferrer">
            FUnIE-GAN
          </a>{" "}
          (Islam et al., RAL 2020) — a U-Net trained end-to-end on the EUVP
          underwater dataset. It learns the inverse of the underwater
          attenuation directly from data, with no per-image stats to tune. On
          most footage it produces noticeably more natural colour than the
          classical CLAHE + Shades-of-Gray pipeline, especially on deep / very
          green water.
        </p>
        <p>
          The model is a one-time <b>~{FUNIE_SIZE_MB.toFixed(0)} MB</b>{" "}
          download from this site, then it's cached on your device — subsequent
          uses are instant and offline. Inference runs locally on WebGPU when
          available, otherwise WASM. Output is fixed at 256×256 internally and
          upscaled.
        </p>
        <div className="actions">
          <button
            className="ghost"
            onClick={() => {
              setShowFuniePrompt(false);
              setQuality("classical");
              const f = pendingFileRef.current;
              pendingFileRef.current = null;
              if (f) handleFile(f);
            }}
          >
            Use Classical instead
          </button>
          <button className="primary" onClick={confirmFunieDownloadAndProceed}>
            Download &amp; continue
          </button>
        </div>
      </Modal>
      <Modal
        open={funieDownloadPct !== null}
        onClose={cancelFunieDownload}
        title="Downloading AI model…"
      >
        <p>This is a one-time download. Subsequent uses are instant.</p>
        <div className="progress" style={{ height: 8, marginTop: 8 }}>
          <div className="bar" style={{ width: `${(funieDownloadPct || 0) * 100}%` }} />
        </div>
        <p style={{ textAlign: "center", marginTop: 12, fontSize: 13 }}>
          {Math.round((funieDownloadPct || 0) * 100)}%
        </p>
        <div className="actions">
          <button className="ghost" onClick={cancelFunieDownload}>Cancel</button>
        </div>
      </Modal>
      <Modal open={showInfo} onClose={() => setShowInfo(false)} title="How Aqua Fix works">
        <h4>Pipeline</h4>
        <p>
          Each frame runs through a single WebGL fragment shader on-device:
        </p>
        <ul>
          <li>
            <b>Channel compensation</b> — lift the absorbed red and blue
            channels using the green channel as a guide before any other
            step. Prevents the purple cast naive white-balance produces on
            red-deficient images.
          </li>
          <li>
            <b>Shades-of-Gray white balance</b> — derive per-channel gains
            from Minkowski p-norms (p=6) of the compensated image, clamped
            to a safe range so deep blue scenes can be lifted without
            blowout.
          </li>
          <li>
            <b>Percentile stretch</b> — bound to <code>[0, 1]</code> with a
            minimum span floor so flat scenes don't get over-amplified.
          </li>
          <li>
            <b>CLAHE-style luminance equalisation</b> — histogram of the
            BT.709 luma, clipped at 3% per bin, redistributed; the resulting
            tone LUT rescales RGB by the <code>L_out / L_in</code> ratio so
            colour balance is preserved while local contrast comes back.
          </li>
          <li>
            <b>Optional Lightroom .cube LUT</b> — packed as a 2D-tiled 3D
            texture, trilinear lookup in the shader.
          </li>
          <li>
            <b>Adaptive tracking</b> — stats are re-sampled every ~1s and
            EMA-blended at 15% so cast changes through a clip
            (descent, scene cuts) are tracked without flicker.
          </li>
        </ul>
        <h4>Papers</h4>
        <ul>
          <li>
            Ancuti, Ancuti, De Vleeschouwer, Bekaert (2018) —{" "}
            <a
              href="https://ieeexplore.ieee.org/document/8059845"
              target="_blank"
              rel="noopener noreferrer"
            >
              Color Balance and Fusion for Underwater Image Enhancement (IEEE TIP)
            </a>
          </li>
          <li>
            Finlayson & Trezzi (2004) —{" "}
            <a
              href="https://ivrl.epfl.ch/wp-content/uploads/2018/08/Finlayson_2004.pdf"
              target="_blank"
              rel="noopener noreferrer"
            >
              Shades of Gray and Colour Constancy (CIC)
            </a>
          </li>
          <li>
            Pizer et al. (1987) — Adaptive Histogram Equalization and its
            Variations (CLAHE)
          </li>
          <li>
            Reference impl that informed defaults:{" "}
            <a
              href="https://github.com/bornfree/dive-color-corrector"
              target="_blank"
              rel="noopener noreferrer"
            >
              bornfree/dive-color-corrector
            </a>
          </li>
        </ul>
        <h4>Source</h4>
        <p>
          <a
            href="https://github.com/majdyz/video"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/majdyz/video
          </a>{" "}
          — both apps live in the same repo.
        </p>
      </Modal>

      <div
        className={`stage ${mode === "idle" ? "is-empty" : ""}`}
        onClick={(e) => {
          if (mode !== "video" || recording) return;
          if ((e.target as HTMLElement).closest("button")) return;
          // Suppress play/pause when the wipe is open — iOS dispatches
          // a synthetic click after pointerup, so a finger-drag of the
          // wipe handle that happens to land outside the bar still
          // bubbled here and toggled playback.
          if (compareActive) return;
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
          <CompareWipe
            active={compareActive}
            value={compareSplit}
            onChange={setCompareSplit}
            onToggle={() => setCompareActive((a) => !a)}
            canvasRef={canvasRef}
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
            <div className="model-picker">
              <button
                type="button"
                className={`model-card${quality === "classical" ? " active" : ""}`}
                disabled={recording}
                onClick={() => setQuality("classical")}
                aria-pressed={quality === "classical"}
              >
                <span className="model-title">Classical</span>
                <span className="model-sub">CLAHE + Shades-of-Gray, runs on every device.</span>
              </button>
              <button
                type="button"
                className={`model-card${quality === "ai" ? " active" : ""}`}
                disabled={recording}
                onClick={() => {
                  if (funieReady) {
                    setQuality("ai");
                    return;
                  }
                  if (funieDownloadPct !== null) return;
                  if (funieCached) {
                    loadFunieFromCacheAndSwitch();
                    return;
                  }
                  setShowFuniePrompt(true);
                }}
                aria-pressed={quality === "ai"}
              >
                <span className="model-title">
                  AI
                  <span className="model-badge model-badge--experimental">Experimental</span>
                </span>
                <span className="model-sub">
                  {funieReady || funieCached
                    ? "FUnIE-GAN. Sometimes less natural than Classical — try both."
                    : `FUnIE-GAN. One-time ${FUNIE_SIZE_MB.toFixed(0)} MB download.`}
                </span>
              </button>
            </div>

            {quality === "classical" && (
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
              </>
            )}

            {quality === "ai" && !funieReady && (
              <p className="note">
                AI model not loaded yet — pick a file to start the {FUNIE_SIZE_MB.toFixed(0)} MB
                download, or switch back to Classical.
              </p>
            )}
            {quality === "ai" && funieReady && (
              <div className="sliders">
                <Slider label="Strength" value={aiStrength} min={0} max={1} step={0.01}
                  onChange={setAiStrength} disabled={recording} />
              </div>
            )}

            {quality === "classical" && (
            <AdvancedDisclosure disabled={recording}>
              {mode === "video" && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={dynamicGrade}
                    disabled={recording}
                    onChange={(e) => setDynamicGrade(e.target.checked)}
                  />
                  <span className="checkbox-row-label">
                    <span>Dynamic grading</span>
                    <span className="checkbox-row-hint">
                      Re-balance white-point as the scene changes. Off by
                      default — can suddenly tint a good frame red when a
                      fish swims through or the camera pans.
                    </span>
                  </span>
                </label>
              )}
              <div className="lut-picker">
                {lutName ? (
                  <div className="lut-chip">
                    <svg className="lut-chip-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 6h16v4H4zM4 12h16v4H4zM4 18h10v2H4z" fill="currentColor" />
                    </svg>
                    <span className="lut-chip-name" title={lutName}>{lutName}</span>
                    <button
                      type="button"
                      className="lut-chip-clear"
                      onClick={clearLUT}
                      aria-label="Remove LUT"
                      disabled={recording}
                    >×</button>
                  </div>
                ) : null}
                <label className="lut-button">
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
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h16v4H4zM4 12h16v4H4zM4 18h10v2H4z" fill="currentColor" />
                  </svg>
                  <span className="lut-button-text">
                    {lutName ? "Replace LUT" : "Add Lightroom .cube LUT"}
                  </span>
                </label>
              </div>
              <Slider label="LUT mix" value={settings.lutMix} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, lutMix: v }))} disabled={recording || !lutName} />
              <Slider label="CLAHE" value={settings.clahe} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, clahe: v }))} disabled={recording} />
              <Slider label="Gamma" value={settings.gamma} min={0.5} max={1.5} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, gamma: v }))} disabled={recording} />
              <Slider label="Contrast" value={settings.contrast} min={0} max={1} step={0.01}
                onChange={(v) => setSettings((s) => ({ ...s, contrast: v }))} disabled={recording} />
            </AdvancedDisclosure>
            )}

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
        <p>
          Companion: <a href="../motion-fix/" style={{ color: "#ff8b4a" }}>Motion Fix</a> · Tap Share → "Add to Home Screen" to install.
        </p>
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
