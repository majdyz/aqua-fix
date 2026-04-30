// Adobe .cube 3D LUT parser. Spec: rows of "r g b" floats, preceded by
// LUT_3D_SIZE n. Optional DOMAIN_MIN / DOMAIN_MAX for input range remap.

export type ParsedLUT = {
  size: number;
  data: Uint8Array; // RGBA, laid out as width = size*size, height = size
  domainMin: [number, number, number];
  domainMax: [number, number, number];
};

export function parseCube(text: string): ParsedLUT {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const triplets: number[][] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("TITLE")) continue;
    if (line.startsWith("LUT_1D_SIZE")) {
      throw new Error("1D LUTs aren't supported — export a 3D LUT from Lightroom");
    }
    if (line.startsWith("LUT_3D_SIZE")) {
      const n = parseInt(line.split(/\s+/)[1], 10);
      if (!Number.isFinite(n) || n < 2 || n > 64) {
        throw new Error("LUT size out of range (need 2..64)");
      }
      size = n;
      continue;
    }
    if (line.startsWith("DOMAIN_MIN")) {
      const parts = line.split(/\s+/).slice(1).map(parseFloat);
      if (parts.length >= 3) domainMin = [parts[0], parts[1], parts[2]];
      continue;
    }
    if (line.startsWith("DOMAIN_MAX")) {
      const parts = line.split(/\s+/).slice(1).map(parseFloat);
      if (parts.length >= 3) domainMax = [parts[0], parts[1], parts[2]];
      continue;
    }
    const parts = line.split(/\s+/).map(parseFloat);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      triplets.push([parts[0], parts[1], parts[2]]);
    }
  }

  if (size === 0) throw new Error("No LUT_3D_SIZE in file");
  const expected = size * size * size;
  if (triplets.length !== expected) {
    throw new Error(`Expected ${expected} entries but got ${triplets.length}`);
  }

  // .cube ordering: R varies fastest, then G, then B (z-slice).
  // Pack into 2D: width = size*size, height = size. Each slice (B index) is
  // laid horizontally; within a slice X = R, Y = G.
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const srcIdx = b * size * size + g * size + r;
        const [tr, tg, tb] = triplets[srcIdx];
        const x = b * size + r;
        const y = g;
        const dstIdx = (y * size * size + x) * 4;
        data[dstIdx] = clamp8(tr * 255);
        data[dstIdx + 1] = clamp8(tg * 255);
        data[dstIdx + 2] = clamp8(tb * 255);
        data[dstIdx + 3] = 255;
      }
    }
  }

  return { size, data, domainMin, domainMax };
}

function clamp8(v: number): number {
  v = Math.round(v);
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}
