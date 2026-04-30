// Motion Fix branding: a stylized waveform / motion mark.
export function MotionFixLogo() {
  return (
    <svg viewBox="0 0 32 32">
      <defs>
        <linearGradient id="mfix-lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb84d" />
          <stop offset="1" stopColor="#ff5e7e" />
        </linearGradient>
      </defs>
      {/* horizontal motion bars of varying length, suggesting smoothing */}
      <rect x="6" y="9" width="6" height="2.4" rx="1.2" fill="url(#mfix-lg)" opacity="0.55" />
      <rect x="6" y="14" width="14" height="2.4" rx="1.2" fill="url(#mfix-lg)" opacity="0.85" />
      <rect x="6" y="19" width="9" height="2.4" rx="1.2" fill="url(#mfix-lg)" opacity="0.7" />
      {/* the "lock-in" dot — symbolizes stabilized output */}
      <circle cx="24" cy="15.2" r="2.6" fill="url(#mfix-lg)" />
    </svg>
  );
}

export const MOTION_FIX_BRAND = {
  name: "Motion Fix",
  tagline: "stabilize shaky video on-device",
  filenamePrefix: "motion",
  opfsPrefix: "motion",
  themeColor: "#ff8b4a",
};
