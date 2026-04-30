# Aqua Fix

Underwater color correction in your browser. PWA — install to your iPhone home screen, works offline, runs entirely on-device (no upload).

Deployed at: https://majdyz.github.io/aqua-fix

## What it does

Underwater photos lose red first, then orange, then yellow as depth increases. Aqua Fix runs each image through:

1. **Auto white balance** — per-channel histogram stretch (1st–99th percentile) restores the dynamic range water compressed.
2. **Red channel boost** — adaptive add-back of `(B+G)/2 - R` where the red channel is weak.
3. **Saturation** — gentle pop after the cast is removed.

All three run in a WebGL fragment shader, so video preview stays at 60fps on a recent iPhone.

## Modes

- **Photos**: pick or capture → live-preview correction → save corrected JPEG.
- **Videos**: live preview only. iOS Safari's `MediaRecorder` is too inconsistent to reliably re-encode underwater video at full quality. Use a desktop tool for that step.

## Local development

```bash
pnpm install
pnpm dev
```

Build & preview:

```bash
pnpm build
pnpm preview
```

## Deploy to GitHub Pages

Same workflow as `chat-wa`:

```bash
# one-time: create the repo on GitHub
gh repo create aqua-fix --public --source . --remote origin --push

# every release
pnpm deploy
```

`pnpm deploy` runs `pnpm build` and pushes `dist/` to the `gh-pages` branch via the `gh-pages` package. In repo settings, set GitHub Pages to serve from the `gh-pages` branch.

The Vite `base` is set to `/aqua-fix/` in `vite.config.ts` so all asset paths resolve correctly under the project subpath.

## Install on iPhone

1. Open https://majdyz.github.io/aqua-fix in Safari.
2. Tap the Share icon.
3. "Add to Home Screen".

The app opens fullscreen, hides Safari's chrome, and works offline after the first load (service worker caches the bundle).

## Project layout

```
src/
  App.tsx            UI: file picker, canvas stage, sliders, save
  lib/correct.ts     WebGL renderer + per-channel stats
public/
  manifest.webmanifest
  sw.js              cache-first service worker
  icon.svg           source icon (PNG variants generated at build)
scripts/
  build-icons.mjs    sharp-based PNG generation
```
