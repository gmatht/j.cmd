// ─── gl-tex-gate.mjs — the texture-window path on headless-gl ────
// The REAL transformed shaders + an uploaded haystack texture, run on
// headless-gl (SwiftShader). Timing here would mislead (software
// rasteriser) — this is an EQUALITY gate: the chunked texture-window
// pipeline (and the offset-axis tiling, where the same compiled shader
// runs every tile via the uTileStart uniform) must reproduce the exact
// CPU reference at haystack lengths far past the inline ARR_CAP.
// Imported by __fuzzy-bench.mjs §4d; also runnable standalone:
//   node gl-tex-gate.mjs        → prints the gate verdict
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
    haystackTexelData, tileLayout, decodeRGBA, reducePartials, cpuFuzzy,
  } = deps;

  const CASES = [
    { nl: 200, hl: 5000,  chunk: 128, texW: 4096, tileW: 0 },    // hl » ARR_CAP, 2D layout
    { nl: 600, hl: 5000,  chunk: 200, texW: 4096, tileW: 0 },   // 3 chunks
    { nl: 100, hl: 12000, chunk: 64,  texW: 4096, tileW: 0 },   // 3 rows (2D)
    { nl: 300, hl: 1000,  chunk: 128, texW: 512,  tileW: 0 },   // small, cross-checkable
    { nl: 500, hl: 24000, chunk: 128, texW: 4096, tileW: 8192 }, // 23501 offsets → 3 tiles
  ];

  for (const { nl, hl, chunk, texW, tileW } of CASES) {
    const offsets = hl - nl + 1;
    const needle = [...digits(nl)].map(Number);
    const hay = [...digits(hl)].map(Number);
    const { m, chunks } = fuzzyTextureChunkShaders(needle, hay, { chunkSize: chunk });
    const { width, height, data } = haystackTexelData(hay, texW);
    const useTiles = tileW > 0 && offsets > tileW;
    const layout = useTiles ? tileLayout(offsets, tileW) : { n: 1, tiles: [{ t: 0, start: 0, w: offsets }] };
    const canvasW = useTiles ? tileW : offsets;

    const gl = createGL(canvasW, 1, { preserveDrawingBuffer: true });
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
      const tileLoc = gl.getUniformLocation(prog, "uTileStart");
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      return { prog, tileLoc };
    };
    const renderRead = (prog, w) => {
      gl.useProgram(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(w * 4);
      gl.readPixels(0, 0, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    const partials = [];
    let sentinels = 0;
    for (const ch of chunks) {
      const raw = lib.raw("otranspilerl_glsl", [ch.src], [800]).output;
      const { glsl, fired } = packTextureChunkGLSL(raw, { width, height, tile: useTiles });
      if (!fired) throw new Error("transform did not fire on chunk " + ch.c);
      const pr = makeProgram(glsl);
      if (pr.err) throw new Error("chunk " + ch.c + ": " + pr.err);
      const p = new Int32Array(offsets);
      for (const tile of layout.tiles) {
        gl.viewport(0, 0, tile.w, 1);
        if (useTiles && pr.tileLoc) gl.uniform1i(pr.tileLoc, tile.start);
        const dec = decodeRGBA(renderRead(pr.prog, tile.w), tile.w);
        sentinels += dec.sentinels;
        for (let x = 0; x < tile.w; x++) p[tile.start + x] = dec.scores[x];
      }
      partials.push(p);
    }
    const reduced = reducePartials(partials, offsets);
    const ref = cpuFuzzy(needle, hay);
    const ok = reduced.best === ref.best && reduced.bestX === ref.bestX &&
      reduced.total.every((v, i) => v === ref.scores[i]) && sentinels === 0;
    console.log(
      `  ${String(nl + "/" + hl).padEnd(11)} m=${m} tex=${width}×${height} ` +
      (useTiles ? `tiles=${layout.n} (${tileW}px)` : "1 tile") +
      ` offsets=${offsets} best=${reduced.best}@${reduced.bestX} ==cpuFuzzy ${ok ? "PASS" : "FAIL"} sentinels ${sentinels}`
    );
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
  deps.tileLayout = f.tileLayout;
  deps.decodeRGBA = f.decodeRGBA;
  deps.reducePartials = f.reducePartials;
  deps.cpuFuzzy = f.cpuFuzzy;
  deps.digits = digits;
  const res = await run(deps);
  console.log(res === true ? "TEXTURE-WINDOW GL GATE: PASS" : "TEXTURE-WINDOW GL GATE: FAIL " + res);
  process.exit(res === true ? 0 : 1);
}
