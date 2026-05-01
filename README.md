# video — Aqua Fix + Motion Fix

Two on-device PWAs for diver-shot footage, in one monorepo.

- **Aqua Fix** · https://majdyz.github.io/video/aqua-fix/ — underwater colour
  correction (Ancuti compensation + Shades-of-Gray WB + CLAHE-style tone
  equalisation, optional Lightroom .cube LUT).
- **Motion Fix** · https://majdyz.github.io/video/motion-fix/ — similarity
  stabilisation (translation + rotation + uniform scale). Multi-point grid
  tracking on 128×72 luma thumbnails, Umeyama similarity fit, then
  L1-optimal path smoothing via ADMM (the Grundmann-Kwatra-Essa formulation,
  pentadiagonal banded Cholesky, in-bundle, no LP solver dependency).
- Landing page · https://majdyz.github.io/video/

Both run entirely in the browser, install as standalone PWAs, and process
video at native resolution (4K supported, capped at 30 Mbps to stay under
Safari's MediaRecorder ceiling).

## Algorithms — papers & references

### Aqua Fix

- Ancuti, Ancuti, De Vleeschouwer & Bekaert (2018) —
  [Color Balance and Fusion for Underwater Image Enhancement](https://ieeexplore.ieee.org/document/8059845)
  (IEEE TIP). Channel-compensation + gray-world / multi-scale fusion pipeline;
  the conceptual basis for the colour-correction shader here.
- Finlayson & Trezzi (2004) —
  [Shades of Gray and Colour Constancy](https://ivrl.epfl.ch/wp-content/uploads/2018/08/Finlayson_2004.pdf)
  (CIC). The Minkowski p-norm white-balance estimator (p=6) used after
  channel compensation.
- Pizer et al. (1987) — Adaptive Histogram Equalization and its Variations.
  CLAHE applied here as a **luminance-only** tone LUT (3% bin clipping,
  excess redistributed) so contrast is enhanced without colour shift.
- Reference implementation that informed the defaults:
  [bornfree/dive-color-corrector](https://github.com/bornfree/dive-color-corrector)
  — popular open Dive+-style implementation.

### Motion Fix

- Grundmann, Kwatra & Essa (2011) —
  [Auto-Directed Video Stabilization with Robust L1 Optimal Camera Paths](https://research.google.com/pubs/archive/37041.pdf)
  (CVPR). The Google/YouTube stabiliser: feature tracking + motion
  estimation + L1-optimal path. Motion Fix uses the same L1 first- and
  second-difference penalty (jitter + acceleration) via an ADMM solver
  shipped in-bundle — no LP-solver dependency. The full paper formulation
  also weights a third derivative (jerk) and adds explicit
  constant/linear/parabolic regime constraints via linear programming;
  that's the natural next upgrade.
- Umeyama (1991) —
  [Least-Squares Estimation of Transformation Parameters Between Two Point Patterns](https://web.stanford.edu/class/cs273/refs/umeyama.pdf)
  (IEEE TPAMI). Closed-form similarity-transform fit used per frame on
  the inlier matches.
- Lucas & Kanade (1981) — feature-tracking literature underlying the
  optical-flow approach. We use patch-based block-matching at low
  resolution instead, to keep the bundle small.

The "How it works" button in each app's header opens a modal with the same
explanation and links.

## Repo layout

```
.
├── apps/
│   ├── aqua-fix/                 colour corrector — base /video/aqua-fix/
│   └── motion-fix/               stabiliser     — base /video/motion-fix/
├── packages/
│   └── shared/                   reusable UI + recorder + theme
├── scripts/
│   └── assemble-dist.mjs         builds dist/<app>/ + landing index.html
├── pnpm-workspace.yaml
└── package.json                  root orchestrator + gh-pages deploy
```

## Local development

```bash
pnpm install
pnpm dev:aqua    # starts apps/aqua-fix dev server
pnpm dev:motion  # starts apps/motion-fix dev server
```

Build everything and assemble for deploy:

```bash
pnpm build
```

## Deploy

```bash
pnpm deploy   # runs pnpm build then gh-pages -d dist
```

The `gh-pages` branch is served at `https://majdyz.github.io/video/`.

## Install on iPhone

Open the URL in Safari → Share → **Add to Home Screen**. Each app installs
as a separate icon and launches fullscreen.
