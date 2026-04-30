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
uniform vec3 u_min;
uniform vec3 u_max;
uniform float u_intensity;
uniform float u_redBoost;
uniform float u_saturation;
varying vec2 v_uv;

void main() {
  vec4 src = texture2D(u_image, v_uv);
  vec3 range = max(u_max - u_min, vec3(1e-3));
  vec3 stretched = clamp((src.rgb - u_min) / range, 0.0, 1.0);
  float redComp = max(0.0, (stretched.b + stretched.g) * 0.5 - stretched.r);
  stretched.r = clamp(stretched.r + u_redBoost * redComp, 0.0, 1.0);
  float gray = dot(stretched, vec3(0.299, 0.587, 0.114));
  stretched = mix(vec3(gray), stretched, u_saturation);
  vec3 finalColor = mix(src.rgb, stretched, u_intensity);
  gl_FragColor = vec4(finalColor, src.a);
}
`;

export type Stats = { min: [number, number, number]; max: [number, number, number] };

export type Settings = {
  intensity: number;
  redBoost: number;
  saturation: number;
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
  private buffer: WebGLBuffer;
  private locs: {
    pos: number;
    image: WebGLUniformLocation;
    min: WebGLUniformLocation;
    max: WebGLUniformLocation;
    intensity: WebGLUniformLocation;
    redBoost: WebGLUniformLocation;
    saturation: WebGLUniformLocation;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
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

    this.locs = {
      pos: gl.getAttribLocation(prog, "a_pos"),
      image: gl.getUniformLocation(prog, "u_image")!,
      min: gl.getUniformLocation(prog, "u_min")!,
      max: gl.getUniformLocation(prog, "u_max")!,
      intensity: gl.getUniformLocation(prog, "u_intensity")!,
      redBoost: gl.getUniformLocation(prog, "u_redBoost")!,
      saturation: gl.getUniformLocation(prog, "u_saturation")!,
    };
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
    gl.uniform3fv(this.locs.min, stats.min);
    gl.uniform3fv(this.locs.max, stats.max);
    gl.uniform1f(this.locs.intensity, settings.intensity);
    gl.uniform1f(this.locs.redBoost, settings.redBoost);
    gl.uniform1f(this.locs.saturation, settings.saturation);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

export function computeStats(source: CanvasImageSource, srcWidth: number, srcHeight: number): Stats {
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

  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  const total = w * h;
  for (let i = 0; i < data.length; i += 4) {
    histR[data[i]]++;
    histG[data[i + 1]]++;
    histB[data[i + 2]]++;
  }

  const lowFrac = 0.01;
  const highFrac = 0.99;
  const findCut = (hist: Uint32Array, frac: number) => {
    const target = frac * total;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i;
    }
    return 255;
  };

  const minR = findCut(histR, lowFrac) / 255;
  const minG = findCut(histG, lowFrac) / 255;
  const minB = findCut(histB, lowFrac) / 255;
  const maxR = findCut(histR, highFrac) / 255;
  const maxG = findCut(histG, highFrac) / 255;
  const maxB = findCut(histB, highFrac) / 255;

  return { min: [minR, minG, minB], max: [maxR, maxG, maxB] };
}
