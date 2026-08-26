// ─── gl-tex-gate.mjs — the texture-window paths on headless-gl ────
// The REAL transformed shaders + uploaded textures, run on headless-gl
// (SwiftShader). Timing here would mislead (software rasteriser) — this
// is an EQUALITY gate with two transports:
//
//   A. chunked texture-window — the haystack in uTex, the needle chunk
//      inline per chunk (one compile per chunk);
//   B. the compile-once TEMPLATE — the needle also in a texture (uCrack
//      via the cr_* bridge), the chunk window (uNeedleLen/uNeedleStart)
//      and the offset tile (uTileStart) as uniforms → ONE compiled
//      shader runs every chunk/tile; the loop bound is a dynamic
//      uniform, verified here on SwiftShader.
//
// Both must reproduce the exact CPU reference (0 sentinels) at haystack
// and needle lengths far past the inline ARR_CAP, including tiled
// offsets. Imported by __fuzzy-bench.mjs §4d/§5; also runnable
// standalone:
//   node gl-tex-gate.mjs        → prints the gate table
// Exit 0 only when every case passes.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createGL = require("gl");

const VERT = `
attribute vec2 aPos;
varying highp vec2 vUv;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;

function uploadTex(gl, unit, data, w, h) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
}

function makeProgram(gl, fragSrc) {
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
  return { prog, uCrack: gl.getUniformLocation(prog, "uCrack"),
           len: gl.getUniformLocation(prog, "uNeedleLen"),
           start: gl.getUniformLocation(prog, "uNeedleStart"),
           tile: gl.getUniformLocation(prog, "uTileStart") };
}

const renderRead = (gl, prog, w) => {
  gl.useProgram(prog);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(w * 4);
  gl.readPixels(0, 0, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
};

export async function run(deps) {
  const {
    lib, digits,
    fuzzyTextureChunkShaders, packTextureChunkGLSL, haystackTexelData,
    fuzzyTemplateShader, compileTemplateGLSL, needleTexelData, templateChunkWindows,
    tileLayout, decodeRGBA, reducePartials, cpuFuzzy,
  } = deps;

  const results = [];

  // ── A. the chunked texture-window transport (needle inline per chunk) ──
  const CHUNKED_CASES = [
    { nl: 200, hl: 5000,  chunk: 128, texW: 4096, tileW: 0 },
    { nl: 600, hl: 5000,  chunk: 200, texW: 4096, tileW: 0 },
    { nl: 100, hl: 12000, chunk: 64,  texW: 4096, tileW: 0 },
    { nl: 300, hl: 1000,  chunk: 128, texW: 512,  tileW: 0 },
    { nl: 500, hl: 24000, chunk: 128, texW: 4096, tileW: 8192 },
  ];
  console.log("  [A] chunked texture-window (one compile per chunk):");
  for (const { nl, hl, chunk, texW, tileW } of CHUNKED_CASES) {
    const offsets = hl - nl + 1;
    const needle = [...digits(nl)].map(Number);
    const hay = [...digits(hl)].map(Number);
    const { m, chunks } = fuzzyTextureChunkShaders(needle, hay, { chunkSize: chunk });
    const { width, height, data } = haystackTexelData(hay, texW);
    const useTiles = tileW > 0 && offsets > tileW;
    const layout = useTiles ? tileLayout(offsets, tileW) : { n: 1, tiles: [{ t: 0, start: 0, w: offsets }] };
    const canvasW = useTiles ? tileW : offsets;

    const gl = createGL(canvasW, 1, { preserveDrawingBuffer: true });
    uploadTex(gl, 0, data, width, height);

    const partials = [];
    let sentinels = 0;
    for (const ch of chunks) {
      const raw = lib.raw("otranspilerl_glsl", [ch.src], [800]).output;
      const { glsl, fired } = packTextureChunkGLSL(raw, { width, height, tile: useTiles });
      if (!fired) throw new Error("chunked transform did not fire");
      const pr = makeProgram(gl, glsl);
      if (pr.err) throw new Error("chunk " + ch.c + ": " + pr.err);
      const p = new Int32Array(offsets);
      for (const tile of layout.tiles) {
        gl.viewport(0, 0, tile.w, 1);
        if (useTiles && pr.tile) gl.uniform1i(pr.tile, tile.start);
        const dec = decodeRGBA(renderRead(gl, pr.prog, tile.w), tile.w);
        sentinels += dec.sentinels;
        for (let x = 0; x < tile.w; x++) p[tile.start + x] = dec.scores[x];
      }
      partials.push(p);
    }
    const reduced = reducePartials(partials, offsets);
    const ref = cpuFuzzy(needle, hay);
    const ok = reduced.best === ref.best && reduced.bestX === ref.bestX &&
      reduced.total.every((v, i) => v === ref.scores[i]) && sentinels === 0;
    console.log(`    ${String(nl + "/" + hl).padEnd(11)} m=${m} tex=${width}×${height} ` +
      (useTiles ? `tiles=${layout.n} ` : "") + `best=${reduced.best}@${reduced.bestX} ==cpuFuzzy ${ok ? "PASS" : "FAIL"} sentinels ${sentinels}`);
    if (!ok) return `chunked ${nl}/${hl}: ${reduced.best}@${reduced.bestX} vs ${ref.best}@${ref.bestX}`;
  }

  // ── B: the compile-once TEMPLATE (needle in uCrack; uniform windows) ──
  const TEMPLATE_CASES = [
    { nl: 2000, hl: 5000,  chunk: 700, texW: 4096, tileW: 0 },    // needle » ARR_CAP
    { nl: 2000, hl: 12000, chunk: 600, texW: 4096, tileW: 0 },
    { nl: 500,  hl: 5000,  chunk: 128, texW: 4096, tileW: 0 },
    { nl: 2000, hl: 24000, chunk: 512, texW: 4096, tileW: 8192 }, // tiled + needle » ARR_CAP
  ];
  console.log("  (B) compile-once template (needle in uCrack, uniform windows):");
  for (const { nl, hl, chunk, texW, tileW } of TEMPLATE_CASES) {
    const offsets = hl - nl + 1;
    const needle = [...digits(nl)].map(Number);
    const hay = [...digits(hl)].map(Number);
    const { m, chunks } = templateChunkWindows(nl, chunk);
    const hayTex = haystackTexelData(hay, texW);
    const ndlTex = needleTexelData(needle, texW);
    const useTiles = tileW > 0 && offsets > tileW;
    const layout = useTiles ? tileLayout(offsets, tileW) : { n: 1, tiles: [{ t: 0, start: 0, w: offsets }] };
    const canvasW = useTiles ? tileW : offsets;

    const gl = createGL(canvasW, 1, { preserveDrawingBuffer: true });
    uploadTex(gl, 0, hayTex.data, hayTex.width, hayTex.height); // uTex
    uploadTex(gl, 1, ndlTex.data, ndlTex.width, ndlTex.height); // uCrack

    // THE ONE COMPILE
    const raw = lib.raw("otranspilerl_glsl", [fuzzyTemplateShader()], [800]).output;
    const { glsl, fired } = compileTemplateGLSL(raw, { width: texW, height: hayTex.height, crackWidth: texW, crackHeight: ndlTex.height, tile: useTiles });
    if (!fired) throw new Error("template transform did not fire");
    const pr = makeProgram(gl, glsl);
    if (pr.err) throw new Error("template: " + pr.err);
    if (pr.uCrack) gl.uniform1i(pr.uCrack, 1);

    const partials = [];
    let sentinels = 0;
    for (const ch of chunks) {
      const p = new Int32Array(offsets);
      for (const tile of layout.tiles) {
        gl.viewport(0, 0, tile.w, 1);
        if (useTiles && pr.tile) gl.uniform1i(pr.tile, tile.start);
        gl.uniform1i(pr.len, ch.len);
        gl.uniform1i(pr.start, ch.start);
        const dec = decodeRGBA(renderRead(gl, pr.prog, tile.w), tile.w);
        sentinels += dec.sentinels;
        for (let x = 0; x < tile.w; x++) p[tile.start + x] = dec.scores[x];
      }
      partials.push(p);
    }
    const reduced = reducePartials(partials, offsets);
    const ref = cpuFuzzy(needle, hay);
    const ok = reduced.best === ref.best && reduced.bestX === ref.bestX &&
      reduced.total.every((v, i) => v === ref.scores[i]) && sentinels === 0;
    console.log(`    ${String(nl + "/" + hl + " C=" + chunk).padEnd(16)} chunks=${String(m).padStart(2)} compiles=1 ` +
      (useTiles ? `tiles=${layout.n} ` : "") + `best=${reduced.best}@${reduced.bestX} ==cpuFuzzy ${ok ? "PASS" : "FAIL"} sentinels ${sentinels}`);
    if (!ok) return { template: `${nl}/${hl}: ${reduced.best}@${reduced.bestX} vs ${ref.best}@${ref.bestX}` };
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
  for (const k of ["fuzzyTextureChunkShaders", "packTextureChunkGLSL", "haystackTexelData",
                   "fuzzyTemplateShader", "compileTemplateGLSL", "needleTexelData", "templateChunkWindows",
                   "tileLayout", "decodeRGBA", "reducePartials", "cpuFuzzy"]) deps[k] = f[k];
  deps.digits = digits;
  const res = await run(deps);
  console.log(res === true ? "GL GATE: PASS" : "GL GATE: FAIL " + JSON.stringify(res));
  process.exit(res === true ? 0 : 1);
}
