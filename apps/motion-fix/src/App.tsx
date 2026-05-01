import { useEffect, useMemo, useRef, useState } from "react";
import {
  attachAudioRouting,
  buildCaptureContext,
  BusyOverlay,
  captureAudioForRecording,
  createRecordingSink,
  FilePickerButton,
  Hero,
  Modal,
  PlaceholderDropZone,
  PlayOverlay,
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
import "./motion-theme.css";
import { MotionFixLogo, MOTION_FIX_BRAND } from "./branding";
import {
  analyzeVideo,
  type AnalysisResult,
  frameIndexForTime,
  gaussianSmooth,
  sigmaForSmoothing,
} from "./lib/stabilizer";

type Mode = "idle" | "video";
type AudioRouting = ReturnType<typeof attachAudioRouting>;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileNameRef = useRef<string>(MOTION_FIX_BRAND.filenamePrefix);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const previewActiveRef = useRef(false);
  const recordingFlagRef = useRef(false);
  const audioRoutingRef = useRef<AudioRouting>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const onEndedRef = useRef<(() => void) | null>(null);
  const sinkRef = useRef<RecordingSink | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const analysisRef = useRef<AnalysisResult | null>(null);
  const smoothedXRef = useRef<Float32Array | null>(null);
  const smoothedYRef = useRef<Float32Array | null>(null);
  const cropRef = useRef(0.1);

  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [smoothing, setSmoothing] = useState(0.6);
  const [crop, setCrop] = useState(0.1);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordTime, setRecordTime] = useState(0);
  const [analysisReady, setAnalysisReady] = useState(false);
  const [canRecord, setCanRecord] = useState(true);
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  // Re-smooth the cumulative path when the slider changes — analysis is
  // expensive but smoothing is a few hundred microseconds.
  useEffect(() => {
    const a = analysisRef.current;
    if (!a) return;
    const sigma = sigmaForSmoothing(smoothing);
    smoothedXRef.current = gaussianSmooth(a.cumX, sigma);
    smoothedYRef.current = gaussianSmooth(a.cumY, sigma);
  }, [smoothing, analysisReady]);

  useEffect(() => {
    setCanRecord(pickRecorderMime() !== null);
    pruneOldRecordings(MOTION_FIX_BRAND.opfsPrefix);
  }, []);

  const { currentTime, isPaused } = useVideoPlaybackState(videoRef, mode === "video", () => {
    drawStabilizedFrame();
  });

  // Repaint when crop slider changes while paused — preview should update
  // immediately even if the video isn't running.
  useEffect(() => {
    if (mode !== "video") return;
    drawStabilizedFrame();
  }, [crop, smoothing, mode]);

  function drawStabilizedFrame() {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    if (v.readyState < 2) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    if (c.width !== v.videoWidth) c.width = v.videoWidth;
    if (c.height !== v.videoHeight) c.height = v.videoHeight;
    applyStabilizedTransform(ctx, c.width, c.height, v.currentTime);
    ctx.drawImage(v, 0, 0, c.width, c.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function applyStabilizedTransform(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    time: number,
  ) {
    const a = analysisRef.current;
    const sx = smoothedXRef.current;
    const sy = smoothedYRef.current;
    const cropAmt = cropRef.current;
    // Uniform scale-up so the translated edges don't reveal the canvas
    // background. (1 - 2*crop) is how much of each axis we're guaranteed to
    // keep within the visible window.
    const scale = 1 / Math.max(0.0001, 1 - 2 * cropAmt);
    if (!a || !sx || !sy) {
      ctx.setTransform(scale, 0, 0, scale, w * (1 - scale) * 0.5, h * (1 - scale) * 0.5);
      return;
    }
    const idx = frameIndexForTime(a, time);
    const dx = a.cumX[idx] - sx[idx];
    const dy = a.cumY[idx] - sy[idx];
    // Clamp the residual to the crop budget so a runaway path can't push the
    // frame entirely off-canvas.
    const maxX = w * cropAmt;
    const maxY = h * cropAmt;
    const tx = -clamp(dx, -maxX, maxX);
    const ty = -clamp(dy, -maxY, maxY);
    // setTransform composes: scale around the center, then translate by the
    // residual. The (1-scale) terms re-center the scaled-up image.
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      w * (1 - scale) * 0.5 + tx,
      h * (1 - scale) * 0.5 + ty,
    );
  }

  type VideoWithRVFC = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };

  function startPreview() {
    const video = videoRef.current as VideoWithRVFC | null;
    if (!video) return;
    previewActiveRef.current = true;
    const useRvfc = typeof video.requestVideoFrameCallback === "function";
    if (useRvfc) {
      const onFrame = () => {
        if (!previewActiveRef.current || recordingFlagRef.current) return;
        drawStabilizedFrame();
        const v = videoRef.current as VideoWithRVFC | null;
        if (v && previewActiveRef.current && !recordingFlagRef.current) {
          v.requestVideoFrameCallback?.(onFrame);
        }
      };
      video.requestVideoFrameCallback?.(onFrame);
    } else {
      const loop = () => {
        if (!previewActiveRef.current || recordingFlagRef.current) return;
        drawStabilizedFrame();
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
    setAnalysisReady(false);
    analysisRef.current = null;
    smoothedXRef.current = null;
    smoothedYRef.current = null;
    teardownVideo();
    fileNameRef.current = file.name.replace(/\.[^.]+$/, "");
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
      setDuration(v.duration || 0);
      setMode("video");

      setBusy("Analyzing motion 0%");
      const result = await analyzeVideo(v, (p) => {
        setBusy(`Analyzing motion ${Math.floor(p * 100)}%`);
      });
      analysisRef.current = result;
      const sigma = sigmaForSmoothing(smoothing);
      smoothedXRef.current = gaussianSmooth(result.cumX, sigma);
      smoothedYRef.current = gaussianSmooth(result.cumY, sigma);
      setAnalysisReady(true);

      v.play().catch(() => undefined);
      startPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

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
    if (!canvas || !video || !analysisRef.current) return;
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

    drawStabilizedFrame();

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
    const sink = await createRecordingSink(MOTION_FIX_BRAND.opfsPrefix);
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

    const renderAndPush = () => {
      if (!recordingFlagRef.current || !videoRef.current) return;
      const v = videoRef.current;
      drawStabilizedFrame();
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
            await shareOrDownload(blob, `${fileNameRef.current}-stabilized.${candidate.ext}`);
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

  const saveDisabled = useMemo(
    () => !analysisReady || recording || !canRecord,
    [analysisReady, recording, canRecord],
  );

  return (
    <div className="app motion-app">
      <div className="bg" aria-hidden="true" />

      <Hero
        logo={<MotionFixLogo />}
        name={MOTION_FIX_BRAND.name}
        tagline={MOTION_FIX_BRAND.tagline}
        onInfoClick={() => setShowInfo(true)}
      />
      <Modal open={showInfo} onClose={() => setShowInfo(false)} title="How Motion Fix works">
        <h4>Pipeline</h4>
        <ul>
          <li>
            <b>Analysis pass</b> — play the video at <code>2×</code> speed
            muted, capture each decoded frame via{" "}
            <code>requestVideoFrameCallback</code>, downsample to a 128×72
            grayscale thumbnail.
          </li>
          <li>
            <b>Block-matching</b> — for each consecutive thumbnail pair,
            find the integer <code>(dx, dy)</code> in <code>±16 px</code>{" "}
            that minimises sum-of-absolute-differences over the overlap;
            sub-pixel parabolic refine on the 3 SAD samples around the
            minimum, separately along x and y.
          </li>
          <li>
            <b>Path</b> — accumulate per-frame translations into a cumulative
            camera path, scaled back to source resolution.
          </li>
          <li>
            <b>Smoothing</b> — separable 1D Gaussian (mirror-padded) on
            <code>cumX</code> / <code>cumY</code>; the slider maps to{" "}
            <code>sigma 1..60</code> frames. Re-smoothing on slider change
            is sub-millisecond — no re-analysis.
          </li>
          <li>
            <b>Render</b> — residual <code>= cum − smoothed</code> applied
            as a 2D canvas <code>setTransform()</code> with a uniform
            scale-up (<code>1 / (1 − 2·crop)</code>) so the translated
            edges don't reveal the canvas background.
          </li>
        </ul>
        <h4>Caveats</h4>
        <p>
          Translation only in v1 — whip-pans and rolling-shutter wobble
          still show. Affine (rotation + scale) and a proper L1-optimal
          path solver are next on the list.
        </p>
        <h4>Papers</h4>
        <ul>
          <li>
            Grundmann, Kwatra, Essa (2011) —{" "}
            <a
              href="https://research.google.com/pubs/archive/37041.pdf"
              target="_blank"
              rel="noopener noreferrer"
            >
              Auto-Directed Video Stabilization with Robust L1 Optimal
              Camera Paths (CVPR)
            </a>
            . The reference for what production-grade stabilisation looks
            like; we ship a simpler Gaussian-smoothed variant.
          </li>
          <li>
            Lucas-Kanade & related feature-tracking literature underlies
            the approach; this app uses block-matching instead to keep the
            bundle small.
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
        {recording && (
          <RecordingOverlay
            currentTime={recordTime}
            duration={duration}
            progress={recordProgress}
          />
        )}
        {mode === "video" && isPaused && !recording && <PlayOverlay />}
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
        <FilePickerButton accept="video/*" disabled={recording} onPick={handleFile}>
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
            <div className="sliders">
              <Slider
                label="Smoothing"
                value={smoothing}
                min={0}
                max={1}
                step={0.01}
                onChange={setSmoothing}
                disabled={recording || !analysisReady}
              />
              <Slider
                label="Max crop"
                value={crop}
                min={0}
                max={0.3}
                step={0.005}
                onChange={setCrop}
                disabled={recording}
              />
            </div>
            <div className="actions">
              {!recording && (
                <button className="primary" onClick={recordVideo} disabled={saveDisabled}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="6" fill="currentColor" />
                  </svg>
                  {canRecord ? "Save stabilised video" : "Recording unsupported"}
                </button>
              )}
              {recording && (
                <button className="danger" onClick={cancelRecording}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <footer>
        <p>
          Companion to{" "}
          <a href="../aqua-fix/" style={{ color: "#5fd0ff" }}>
            Aqua Fix
          </a>
          . Tap Share → "Add to Home Screen".
        </p>
      </footer>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
