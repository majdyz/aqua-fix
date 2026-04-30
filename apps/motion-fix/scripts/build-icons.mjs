import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "public/icon.svg");
const out = resolve(root, "public");
mkdirSync(out, { recursive: true });

const svg = readFileSync(src);

const targets = [
  { name: "icon-192.png", size: 192, padding: 0 },
  { name: "icon-512.png", size: 512, padding: 0 },
  { name: "icon-maskable-512.png", size: 512, padding: 64 },
  { name: "apple-touch-icon.png", size: 180, padding: 0 },
];

for (const t of targets) {
  const inner = t.size - t.padding * 2;
  const buffer = await sharp(svg, { density: 384 })
    .resize(inner, inner)
    .toBuffer();
  await sharp({
    create: {
      width: t.size,
      height: t.size,
      channels: 4,
      background: { r: 6, g: 16, b: 24, alpha: 1 },
    },
  })
    .composite([{ input: buffer, top: t.padding, left: t.padding }])
    .png()
    .toFile(resolve(out, t.name));
  console.log("wrote", t.name);
}
