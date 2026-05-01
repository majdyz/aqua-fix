// Motion Fix branding: a phone (or held device) flanked by motion arcs —
// the universal "vibrate / shake / stabilise this" mark.
export function MotionFixLogo() {
  return (
    <svg viewBox="0 0 32 32">
      <defs>
        <linearGradient id="mfix-lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb84d" />
          <stop offset="1" stopColor="#ff5e7e" />
        </linearGradient>
      </defs>
      {/* device body */}
      <rect x="11" y="7" width="10" height="18" rx="2.2" fill="url(#mfix-lg)" />
      {/* screen window */}
      <rect x="13" y="9.5" width="6" height="10" rx="0.6" fill="#04101c" opacity="0.55" />
      {/* home dot */}
      <circle cx="16" cy="22.2" r="0.85" fill="#04101c" opacity="0.55" />
      {/* shake arcs — left */}
      <path d="M 8.5 11 Q 6 16 8.5 21" stroke="url(#mfix-lg)" strokeWidth="1.7" fill="none" strokeLinecap="round" opacity="0.75" />
      <path d="M 5 9 Q 1.6 16 5 23" stroke="url(#mfix-lg)" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.45" />
      {/* shake arcs — right */}
      <path d="M 23.5 11 Q 26 16 23.5 21" stroke="url(#mfix-lg)" strokeWidth="1.7" fill="none" strokeLinecap="round" opacity="0.75" />
      <path d="M 27 9 Q 30.4 16 27 23" stroke="url(#mfix-lg)" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.45" />
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
