const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform sampler2D u_image;
uniform sampler2D u_lut;
uniform sampler2D u_tone;
uniform vec3 u_mean;
uniform vec3 u_wbGain;
uniform vec3 u_min;
uniform vec3 u_max;
uniform float u_alpha;
uniform float u_intensity;
uniform float u_saturation;
uniform float u_gamma;
uniform float u_contrast;
uniform float u_clahe;
uniform float u_lutSize;
uniform float u_lutMix;
varying vec2 v_uv;

vec3 sCurve(vec3 c, float k) {
  vec3 s = c * c * (3.0 - 2.0 * c);
  return mix(c, s, k);
}

// 3D LUT laid out as width = size*size, height = size. Each B slice tiles
// horizontally; within a slice, X = R, Y = G. Manual lerp across the two
// adjacent B slices, relying on hardware bilinear for R/G inside each slice.
vec3 sampleLUT(vec3 color, float size) {
  float fz = clamp(color.b, 0.0, 1.0) * (size - 1.0);
  float zLow = floor(fz);
  float zHigh = min(zLow + 1.0, size - 1.0);
  float zMix = fz - zLow;

  float r = clamp(color.r, 0.0, 1.0) * (size - 1.0);
  float g = clamp(color.g, 0.0, 1.0) * (size - 1.0);
  float texW = size * size;
  float texH = size;

  vec2 uvLow = vec2(zLow * size + r + 0.5, g + 0.5) / vec2(texW, texH);
  vec2 uvHigh = vec2(zHigh * size + r + 0.5, g + 0.5) / vec2(texW, texH);

  vec3 cLow = texture2D(u_lut, uvLow).rgb;
  vec3 cHigh = texture2D(u_lut, uvHigh).rgb;
  return mix(cLow, cHigh, zMix);
}

void main() {
  vec4 src = texture2D(u_image, v_uv);
  vec3 c = src.rgb;

  // Ancuti channel compensation: lift weak channels using the green channel
  float redComp = max(0.0, u_mean.g - u_mean.r);
  float blueComp = max(0.0, u_mean.g - u_mean.b);
  vec3 comp = c;
  comp.r = c.r + u_alpha * redComp * (1.0 - c.r) * c.g;
  comp.b = c.b + u_alpha * blueComp * (1.0 - c.b) * c.g;

  // Shades-of-Gray white balance (gains derived from compensated Lp norms CPU-side).
  // Clamp to [0,1] first so highlight regions don't get over-amplified by stretch.
  vec3 wb = clamp(comp * u_wbGain, 0.0, 1.0);

  // Soft stretch: input is bounded [0,1], stats are post-clamp percentiles, and
  // the span is clamped to >=0.3 in computeStats so amplification stays sane.
  vec3 stretched = clamp((wb - u_min) / max(u_max - u_min, vec3(1e-3)), 0.0, 1.0);

  // Tone: gamma + S-curve
  vec3 toned = pow(stretched, vec3(u_gamma));
  toned = sCurve(toned, u_contrast);

  // Global luminance histogram equalisation (CLAHE-style). Look up the
  // remapped luminance from the precomputed tone LUT and rescale the RGB
  // by the L_out/L_in ratio so colour balance is preserved.
  if (u_clahe > 0.001) {
    float L_in = dot(toned, vec3(0.2126, 0.7152, 0.0722));
    float L_out = texture2D(u_tone, vec2(L_in, 0.5)).r;
    float ratio = L_out / max(L_in, 0.001);
    vec3 enhanced = clamp(toned * ratio, 0.0, 1.0);
    toned = mix(toned, enhanced, u_clahe);
  }

  // Saturation around BT.709 luminance
  float lum = dot(toned, vec3(0.2126, 0.7152, 0.0722));
  toned = mix(vec3(lum), toned, u_saturation);

  // Optional Lightroom .cube LUT overlay
  if (u_lutMix > 0.001 && u_lutSize > 0.5) {
    vec3 graded = sampleLUT(toned, u_lutSize);
    toned = mix(toned, graded, u_lutMix);
  }

  // Blend with original
  vec3 finalColor = mix(src.rgb, toned, u_intensity);
  gl_FragColor = vec4(finalColor, src.a);
}
`;

export type Stats = {
  mean: [number, number, number];
  wbGain: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  alpha: number;
  // 256x1 RGBA LUT for global luminance histogram equalisation (CLAHE-style).
  // Same value is duplicated across R/G/B/A so any swizzle in the shader works.
  toneLUT: Uint8Array;
};

export type Settings = {
  intensity: number;
  castStrength: number;
  saturation: number;
  gamma: number;
  contrast: number;
  clahe: number;
  lutMix: number;
};

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader compile failed: " + log);
  }
  return sh;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private lutTexture: WebGLTexture;
  private toneTexture: WebGLTexture;
  private lutSize: number = 0;
  private buffer: WebGLBuffer;
  private locs: {
    pos: number;
    image: WebGLUniformLocation;
    lut: WebGLUniformLocation;
    tone: WebGLUniformLocation;
    mean: WebGLUniformLocation;
    wbGain: WebGLUniformLocation;
    min: WebGLUniformLocation;
    max: WebGLUniformLocation;
    alpha: WebGLUniformLocation;
    intensity: WebGLUniformLocation;
    saturation: WebGLUniformLocation;
    gamma: WebGLUniformLocation;
    contrast: WebGLUniformLocation;
    clahe: WebGLUniformLocation;
    lutSize: WebGLUniformLocation;
    lutMix: WebGLUniformLocation;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("Link failed: " + gl.getProgramInfoLog(prog));
    }
    this.program = prog;

    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.lutTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 1×1 placeholder so the sampler is always valid even with no LUT loaded.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    // 256x1 luminance tone LUT, identity by default.
    this.toneTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const idLut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      idLut[i * 4] = i;
      idLut[i * 4 + 1] = i;
      idLut[i * 4 + 2] = i;
      idLut[i * 4 + 3] = 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, idLut);

    this.locs = {
      pos: gl.getAttribLocation(prog, "a_pos"),
      image: gl.getUniformLocation(prog, "u_image")!,
      lut: gl.getUniformLocation(prog, "u_lut")!,
      tone: gl.getUniformLocation(prog, "u_tone")!,
      mean: gl.getUniformLocation(prog, "u_mean")!,
      wbGain: gl.getUniformLocation(prog, "u_wbGain")!,
      min: gl.getUniformLocation(prog, "u_min")!,
      max: gl.getUniformLocation(prog, "u_max")!,
      alpha: gl.getUniformLocation(prog, "u_alpha")!,
      intensity: gl.getUniformLocation(prog, "u_intensity")!,
      saturation: gl.getUniformLocation(prog, "u_saturation")!,
      gamma: gl.getUniformLocation(prog, "u_gamma")!,
      contrast: gl.getUniformLocation(prog, "u_contrast")!,
      clahe: gl.getUniformLocation(prog, "u_clahe")!,
      lutSize: gl.getUniformLocation(prog, "u_lutSize")!,
      lutMix: gl.getUniformLocation(prog, "u_lutMix")!,
    };
  }

  uploadToneLUT(lut: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  uploadLUT(data: Uint8Array, size: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size * size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.lutSize = size;
  }

  clearLUT() {
    this.lutSize = 0;
  }

  hasLUT(): boolean {
    return this.lutSize > 0;
  }

  uploadSource(source: TexImageSource, width: number, height: number) {
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  render(stats: Stats, settings: Settings) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.locs.pos);
    gl.vertexAttribPointer(this.locs.pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.locs.image, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(this.locs.lut, 1);

    this.uploadToneLUT(stats.toneLUT);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
    gl.uniform1i(this.locs.tone, 2);

    gl.uniform3fv(this.locs.mean, stats.mean);
    gl.uniform3fv(this.locs.wbGain, stats.wbGain);
    gl.uniform3fv(this.locs.min, stats.min);
    gl.uniform3fv(this.locs.max, stats.max);
    gl.uniform1f(this.locs.alpha, stats.alpha);
    gl.uniform1f(this.locs.intensity, settings.intensity);
    gl.uniform1f(this.locs.saturation, settings.saturation);
    gl.uniform1f(this.locs.gamma, settings.gamma);
    gl.uniform1f(this.locs.contrast, settings.contrast);
    gl.uniform1f(this.locs.clahe, settings.clahe);
    gl.uniform1f(this.locs.lutSize, this.lutSize);
    gl.uniform1f(this.locs.lutMix, this.lutSize > 0 ? settings.lutMix : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

const SOG_P = 6;
const MAX_GAIN = 4.5;
const MIN_GAIN = 0.4;

export function computeStats(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  alpha: number,
): Stats {
  const target = 256;
  const scale = Math.min(1, target / Math.max(srcWidth, srcHeight));
  const w = Math.max(1, Math.round(srcWidth * scale));
  const h = Math.max(1, Math.round(srcHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < data.length; i += 4) {
    sumR += data[i];
    sumG += data[i + 1];
    sumB += data[i + 2];
  }
  const meanR = sumR / total / 255;
  const meanG = sumG / total / 255;
  const meanB = sumB / total / 255;

  const redCompTerm = Math.max(0, meanG - meanR);
  const blueCompTerm = Math.max(0, meanG - meanB);

  // Compensate red and blue per pixel, accumulate Lp norms (Shades-of-Gray, Finlayson-Trezzi 2004).
  // First pass: compensation + Lp accumulation.
  const compR = new Float32Array(total);
  const compB = new Float32Array(total);
  let sumRp = 0;
  let sumGp = 0;
  let sumBp = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const r2 = r + alpha * redCompTerm * (1 - r) * g;
    const b2 = b + alpha * blueCompTerm * (1 - b) * g;
    compR[p] = r2;
    compB[p] = b2;
    sumRp += Math.pow(r2, SOG_P);
    sumGp += Math.pow(g, SOG_P);
    sumBp += Math.pow(b2, SOG_P);
  }
  const normR = Math.pow(sumRp / total, 1 / SOG_P);
  const normG = Math.pow(sumGp / total, 1 / SOG_P);
  const normB = Math.pow(sumBp / total, 1 / SOG_P);

  const gainR = clampGain(normR > 0.001 ? normG / normR : 1);
  const gainG = 1;
  const gainB = clampGain(normB > 0.001 ? normG / normB : 1);

  // Second pass: histogram of post-WB-and-clamp values for percentile stretch.
  // Working in [0,1] guarantees the stretch can't blow out highlights.
  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = clamp01(compR[p] * gainR);
    const g = clamp01((data[i + 1] / 255) * gainG);
    const b = clamp01(compB[p] * gainB);
    histR[(r * 255) | 0]++;
    histG[(g * 255) | 0]++;
    histB[(b * 255) | 0]++;
  }

  const lowFrac = 0.005;
  const highFrac = 0.995;
  const findCut = (hist: Uint32Array, frac: number) => {
    const targetN = frac * total;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= targetN) return i;
    }
    return 255;
  };

  const MIN_SPAN = 0.3;
  const min: [number, number, number] = [
    findCut(histR, lowFrac) / 255,
    findCut(histG, lowFrac) / 255,
    findCut(histB, lowFrac) / 255,
  ];
  const max: [number, number, number] = [
    findCut(histR, highFrac) / 255,
    findCut(histG, highFrac) / 255,
    findCut(histB, highFrac) / 255,
  ];
  for (let c = 0; c < 3; c++) {
    const span = max[c] - min[c];
    if (span < MIN_SPAN) {
      const center = (max[c] + min[c]) / 2;
      const half = MIN_SPAN / 2;
      min[c] = Math.max(0, center - half);
      max[c] = Math.min(1, center + half);
    }
  }

  // Build the CLAHE-style tone LUT for luminance histogram equalisation.
  // Approximate the post-stretch luminance per sample, build a clipped
  // histogram, redistribute the excess uniformly, then turn the CDF into a
  // 256-entry LUT. The result is a tone curve that boosts contrast where
  // there's actual detail and leaves dominant flat regions alone.
  const histL = new Uint32Array(256);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = clamp01((compR[p] * gainR - min[0]) / Math.max(max[0] - min[0], 1e-3));
    const g = clamp01(((data[i + 1] / 255) * gainG - min[1]) / Math.max(max[1] - min[1], 1e-3));
    const b = clamp01((compB[p] * gainB - min[2]) / Math.max(max[2] - min[2], 1e-3));
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    histL[Math.min(255, (L * 255) | 0)]++;
  }
  // CLAHE clip + redistribute (cap any single bin at ~3% of total).
  const clipLimit = total * 0.03;
  let excess = 0;
  for (let i = 0; i < 256; i++) {
    if (histL[i] > clipLimit) {
      excess += histL[i] - clipLimit;
      histL[i] = clipLimit;
    }
  }
  const redist = excess / 256;
  let cum = 0;
  const toneLUT = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    cum += histL[i] + redist;
    const v = (cum / total) * 255;
    const clamped = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    toneLUT[i * 4] = clamped;
    toneLUT[i * 4 + 1] = clamped;
    toneLUT[i * 4 + 2] = clamped;
    toneLUT[i * 4 + 3] = 255;
  }

  return {
    mean: [meanR, meanG, meanB],
    wbGain: [gainR, gainG, gainB],
    min,
    max,
    alpha,
    toneLUT,
  };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampGain(g: number) {
  return g < MIN_GAIN ? MIN_GAIN : g > MAX_GAIN ? MAX_GAIN : g;
}
