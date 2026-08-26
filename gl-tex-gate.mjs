// ─── gl-tex-gate.mjs — the texture-window path on headless-gl ────
// The REAL transformed shaders + an uploaded haystack texture, run on
// headless-gl (SwiftShader). Timing here would mislead (software
// rasteriser) — this is an EQUALITY gate: the chunked texture-window
// pipeline must reproduce the exact CPU reference at haystack lengths
// far past the inline ARR_CAP. Imported by __fuzzy-bench.mjs §4d; also
// runnable standalone:
//   node gl-tex-gate.mjs        → prints the gate table
// Exit 0 only when every case passes.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createGL = require("gl");

const VERT = `
attribute vec2 aPos;
varying highp vec2 vUv;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;

export async function run(deps) {
  const {
    lib, digits, fuzzyTextureChunkShaders, packTextureChunkGLSL,
    haystackTexelData, decodeRGBA, reducePartials, cpuFuzzy,
  } = deps;

  const CASES = [
    { nl: 200, hl: 5000,  chunk: 128, texW: 4096 }, // hl » ARR_CAP, 2D layout
    { nl: 600, hl: 5000,  chunk: 200, texW: 4096 }, // 3 chunks
    { nl: 100, hl: 12000, chunk: 64,  texW: 4096 }, // 3 rows (2D)
    { nl: 300, hl: 1000,  chunk: 128, texW: 512 },  // small, cross-checkable
  ];

  for (const { nl, hl, chunk, texW } of CASES) {
    const offsets = hl - nl + 1;
    const needle = [...digits(nl)].map(Number);
    const hay = [...digits(hl)].map(Number);
    const { m, chunks } = fuzzyTextureChunkShaders(needle, hay, { chunkSize: chunk });
    const { width, height, data } = haystackTexelData(hay, texW);

    const gl = createGL(offsets, 1, { preserveDrawingBuffer: true });
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);

    const makeProgram = (fragSrc) => {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, VERT); gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return { err: gl.getShaderInfoLog(vs) };
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSrc); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return { err: gl.getShaderInfoLog(fs) };
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { err: gl.getProgramInfoLog(prog) };
      gl.useProgram(prog);
      const loc = gl.getUniformLocation(prog, "uTex");
      if (loc) gl.uniform1i(loc, 0);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, offsets, 1);
      return { prog };
    };
    const renderRead = (prog) => {
      gl.useProgram(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(offsets * 4);
      gl.readPixels(0, 0, offsets, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    const partials = [];
    let sentinels = 0;
    for (const ch of chunks) {
      const raw = lib.raw("otranspilerl_glsl", [ch.src], [800]).output;
      const { glsl, fired } = packTextureChunkGLSL(raw, { width, height });
      if (!fired) throw new Error("window lift did not fire on chunk " + ch.c);
      const pr = makeProgram(glsl);
      if (pr.err) throw new Error("chunk " + ch.c + ": " + pr.err);
      const dec = decodeRGBA(renderRead(pr.prog), offsets);
      sentinels += dec.sentinels;
      partials.push(dec.scores);
    }
    const reduced = reducePartials(partials, offsets);
    const ref = cpuFuzzy(needle, hay);
    const ok = reduced.best === ref.best && reduced.bestX === ref.bestX &&
      reduced.total.every((v, i) => v === ref.scores[i]) && sentinels === 0;
    if (!ok) return `nl=${nl} hl=${hl}: best ${reduced.best}@${reduced.bestX} vs cpuFuzzy ${ref.best}@${ref.bestX}, sentinels ${sentinels}`;
  }
  return true;
}

function digits(len, seed = 12345) {
  let s = seed, o = "";
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) % 2147483648; o += String(s % 10); }
  return o;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = await import("./src/otranspilerl.js").then((m) => ({ lib: m.getOtranspilerl() }));
  deps.lib = await deps.lib;
  const f = await import("./src/fuzzygpu.js");
  deps.fuzzyTextureChunkShaders = f.fuzzyTextureChunkShaders;
  deps.packTextureChunkGLSL = f.packTextureChunkGLSL;
  deps.haystackTexelData = f.haystackTexelData;
  deps.decodeRGBA = f.decodeRGBA;
  deps.reducePartials = f.reducePartials;
  deps.cpuFuzzy = f.cpuFuzzy;
  deps.digits = digits;
  const res = await run(deps);
  console.log(res === true ? "TEXTURE-WINDOW GL GATE: PASS" : "TEXTURE-WINDOW GL GATE: FAIL " + res);
  process.exit(res === true ? 0 : 1);
}
