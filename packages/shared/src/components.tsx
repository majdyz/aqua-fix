/**
 * Shared UI primitives used by both apps. Keeps styling/behaviour identical
 * across the suite — only the brand and the per-app processing differ.
 */
import { useEffect, useState, type ReactNode } from "react";

export function InfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="info-btn" onClick={onClick} aria-label="How it works">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <circle cx="12" cy="7.5" r="1.1" fill="currentColor" />
        <path d="M12 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Slider({
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

export function Scrubber({
  currentTime,
  duration,
  disabled,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  disabled?: boolean;
  onSeek: (t: number) => void;
}) {
  return (
    <div className="scrubber">
      <span className="time">{formatTime(currentTime)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(currentTime, duration || 0)}
        disabled={disabled || !duration}
        onChange={(e) => onSeek(parseFloat(e.target.value))}
      />
      <span className="time">{formatTime(duration)}</span>
    </div>
  );
}

export function FilePickerButton({
  accept,
  disabled,
  onPick,
  children,
}: {
  accept: string;
  disabled?: boolean;
  onPick: (file: File) => void;
  children: ReactNode;
}) {
  return (
    <label className="file">
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <span>{children}</span>
    </label>
  );
}

export function PlaceholderDropZone({
  accept,
  onPick,
  message = "tap to pick a photo or video",
}: {
  accept: string;
  onPick: (file: File) => void;
  message?: string;
}) {
  return (
    <label className="placeholder">
      <input
        type="file"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <div className="dropper">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l4 5h-3v6h-2V8H8l4-5zM5 18h14v2H5z" fill="currentColor" />
        </svg>
        <p>{message}</p>
      </div>
    </label>
  );
}

export function PlayOverlay() {
  return (
    <div className="play-overlay" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z" fill="currentColor" />
      </svg>
    </div>
  );
}

export function CompareButton({
  active,
  onPress,
  onRelease,
}: {
  active: boolean;
  onPress: () => void;
  onRelease: () => void;
}) {
  return (
    <button
      className="compare"
      onPointerDown={onPress}
      onPointerUp={onRelease}
      onPointerLeave={onRelease}
      aria-label="Hold to compare"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 4v16M5 8l-3 4 3 4M19 8l3 4-3 4"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {active ? "Original" : "Hold"}
    </button>
  );
}

export function RecordingOverlay({
  currentTime,
  duration,
  progress,
}: {
  currentTime: number;
  duration: number;
  progress: number;
}) {
  return (
    <div className="recording-overlay">
      <div className="rec-dot" />
      <span>
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <div className="progress">
        <div className="bar" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

export function BusyOverlay({ message }: { message: string }) {
  return (
    <div className="busy">
      <div className="spinner" />
      <span>{message}</span>
    </div>
  );
}

export function AdvancedDisclosure({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="adv-toggle"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
      >
        <span>Advanced</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" className={open ? "open" : ""}>
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && <div className="advanced">{children}</div>}
    </>
  );
}

export function PresetsRow<T>({
  presets,
  current,
  matches,
  onSelect,
  disabled,
}: {
  presets: { label: string; settings: T }[];
  current: T;
  matches: (a: T, b: T) => boolean;
  onSelect: (s: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="presets">
      {presets.map((p) => (
        <button
          key={p.label}
          className={`preset ${matches(current, p.settings) ? "active" : ""}`}
          onClick={() => onSelect(p.settings)}
          disabled={disabled}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function Hero({
  logo,
  name,
  tagline,
  onInfoClick,
}: {
  logo: ReactNode;
  name: string;
  tagline: string;
  onInfoClick?: () => void;
}) {
  return (
    <header className="hero">
      <div className="brand">
        <div className="logo" aria-hidden="true">
          {logo}
        </div>
        <div className="brand-text">
          <h1>{name}</h1>
          <p className="tag">{tagline}</p>
        </div>
        {onInfoClick && <InfoButton onClick={onInfoClick} />}
      </div>
    </header>
  );
}

/**
 * Mirrors a video element's playback state into React. Listens to
 * timeupdate/play/pause/seeked and surfaces currentTime + paused. Also fires
 * onSeeked so callers can repaint their canvas at the new time.
 */
export function useVideoPlaybackState(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  onSeeked?: () => void,
) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onPlay = () => setIsPaused(false);
    const onPause = () => setIsPaused(true);
    const onSeekedHandler = () => {
      setCurrentTime(v.currentTime);
      onSeeked?.();
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeekedHandler);
    setCurrentTime(v.currentTime);
    setIsPaused(v.paused);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeekedHandler);
    };
  }, [videoRef, active, onSeeked]);

  return { currentTime, isPaused };
}
