import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Each app gets its own subpath under /video/
const aquaSrc = resolve(root, "apps/aqua-fix/dist");
const aquaDst = resolve(dist, "aqua-fix");
if (existsSync(aquaSrc)) {
  mkdirSync(aquaDst, { recursive: true });
  cpSync(aquaSrc, aquaDst, { recursive: true });
}

const motionSrc = resolve(root, "apps/motion-fix/dist");
const motionDst = resolve(dist, "motion-fix");
if (existsSync(motionSrc)) {
  mkdirSync(motionDst, { recursive: true });
  cpSync(motionSrc, motionDst, { recursive: true });
}

// Landing page at /video/ that links both apps
writeFileSync(
  resolve(dist, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Dive Tools</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #04101c; color: #e8f3ff; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px; min-height: 100svh; display: flex; flex-direction: column; gap: 32px; }
  h1 { margin: 0; font-size: 32px; letter-spacing: -0.02em; background: linear-gradient(120deg, #b8f0ff, #b6ffe2); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p.intro { margin: 0; color: #7a99b3; line-height: 1.5; }
  .grid { display: grid; gap: 16px; }
  a.card { display: block; padding: 22px 20px; border-radius: 18px; background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)); border: 1px solid rgba(159, 244, 255, 0.18); color: inherit; text-decoration: none; transition: transform 0.1s ease, border-color 0.2s ease; }
  a.card:hover { border-color: rgba(159, 244, 255, 0.35); }
  a.card:active { transform: scale(0.99); }
  a.card h2 { margin: 0 0 6px; font-size: 18px; font-weight: 700; }
  a.card p { margin: 0; color: #7a99b3; font-size: 14px; line-height: 1.4; }
  a.card .arrow { float: right; opacity: 0.5; }
  .aqua h2 { color: #5fd0ff; }
  .motion h2 { color: #ff8b4a; }
  footer { margin-top: auto; color: #4f7088; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Dive Tools</h1>
    <p class="intro">On-device PWAs for diver-shot video. Pick a tool below; both work offline once installed to your home screen.</p>
  </header>
  <nav class="grid">
    <a class="card aqua" href="./aqua-fix/">
      <span class="arrow">→</span>
      <h2>Aqua Fix</h2>
      <p>Underwater colour correction. Removes the blue/green cast, restores red, optional Lightroom .cube LUT.</p>
    </a>
    <a class="card motion" href="./motion-fix/">
      <span class="arrow">→</span>
      <h2>Motion Fix</h2>
      <p>Stabilize shaky clips. Block-matching translation tracker with Gaussian path smoothing.</p>
    </a>
  </nav>
  <footer>Source: github.com/majdyz/video</footer>
</div>
</body>
</html>
`,
);

console.log("Assembled dist/ → /aqua-fix/, /motion-fix/, landing index.html");
