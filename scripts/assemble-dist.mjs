import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// aqua-fix at the root (preserves the existing /aqua-fix/ URL)
cpSync(resolve(root, "apps/aqua-fix/dist"), dist, { recursive: true });

// motion-fix nested at /motion-fix/
const motionSrc = resolve(root, "apps/motion-fix/dist");
const motionDst = resolve(dist, "motion-fix");
if (existsSync(motionSrc)) {
  mkdirSync(motionDst, { recursive: true });
  cpSync(motionSrc, motionDst, { recursive: true });
}

console.log("Assembled dist/ → / (aqua-fix), /motion-fix/");
