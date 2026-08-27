// Verify the page's block-reduction GPU runners (www/gcc-vs-igpu.html logic)
// against the C checksums on headless-gl (SwiftShader) at small sizes.
import { getOtranspilerl } from "../../src/otranspilerl.js";
import { packFragmentResultToRGBA, collapseConsecutiveListLoop, injectPointSize } from "../../src/shglsl-opt.js";
import {
  collatzBlockShader, ca1dBlockShader, hashBlockFragmentShader,
  lowerWhileLoops, lowerBitOps, lowerBranchless,
  checksumAdd, RULE_118,
} from "./c-programs.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { C_SOURCES } from "./c-programs.mjs";
const createGL = (await import("gl")).default;

const VERT = `attribute vec2 aPos; varying highp vec2 vUv;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;
function fragProgram(gl, glsl, w, h) {
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, glsl); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return { err: gl.getShaderInfoLog(fs) };
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { err: gl.getProgramInfoLog(p) };
  gl.useProgram(p);
  const l = gl.getUniformLocation(p, "uTex"); if (l) gl.uniform1i(l, 0);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, "aPos"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, w, h);
  return { p };
}
function decode32(px, i) {
  return px[i * 4] + 256 * px[i * 4 + 1] + 65536 * px[i * 4 + 2] + 16777216 * px[i * 4 + 3];
}
function grid(P) { const TW = Math.ceil(Math.sqrt(P)), TH = Math.ceil(P / TW); return { TW, TH }; }

const lib = await getOtranspilerl();

// Chunked draws (mirrors the page): a single draw of the whole N can exceed the
// D3D11 TDR budget on a weak iGPU and lose the WebGL context, so split N into
// CHUNK_PX-pixel sub-draws (≈51M items each) and sum partial checksums mod 2^32.
const CHUNK_PX = 50000;

function runCollatz(gl, N, BLOCK) {
  N = Math.ceil(N / BLOCK) * BLOCK;
  const totalP = N / BLOCK;
  let checksum = 0;
  for (let basePx = 0; basePx < totalP; basePx += CHUNK_PX) {
    const chunkP = Math.min(CHUNK_PX, totalP - basePx);
    const { TW, TH } = grid(chunkP);
    const raw = lib.raw("otranspilerl_glsl", [lowerBitOps(lowerWhileLoops(lowerBranchless(collatzBlockShader(TW, basePx + chunkP, BLOCK, basePx))))], [800]).output;
    let g = collapseConsecutiveListLoop(raw);
    g = collapseConsecutiveListLoop(g);
    const glsl = packFragmentResultToRGBA(g);
    const pr = fragProgram(gl, glsl, TW, TH);
    if (pr.err) return { err: pr.err };
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(TW * TH * 4);
    gl.readPixels(0, 0, TW, TH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let part = 0;
    for (let i = 0; i < TW * TH; i++) part = checksumAdd("collatz", part, decode32(px, i));
    checksum = (checksum + part) >>> 0;
  }
  return { checksum };
}

function runCa1d(gl, N, BLOCK) {
  N = Math.ceil(N / BLOCK) * BLOCK;
  const totalP = N / BLOCK;
  let checksum = 0;
  for (let basePx = 0; basePx < totalP; basePx += CHUNK_PX) {
    const chunkP = Math.min(CHUNK_PX, totalP - basePx);
    const { TW, TH } = grid(chunkP);
    const raw = lib.raw("otranspilerl_glsl", [lowerBitOps(lowerWhileLoops(lowerBranchless(ca1dBlockShader(TW, basePx + chunkP, N, BLOCK, RULE_118, basePx))))], [800]).output;
    const g = collapseConsecutiveListLoop(raw);
    const glsl = packFragmentResultToRGBA(g);
    const pr = fragProgram(gl, glsl, TW, TH);
    if (pr.err) return { err: pr.err };
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(TW * TH * 4);
    gl.readPixels(0, 0, TW, TH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let part = 0;
    for (let i = 0; i < TW * TH; i++) part = checksumAdd("ca1d", part, decode32(px, i));
    checksum = (checksum + part) >>> 0;
  }
  return { checksum };
}

function runHash(gl, N, BLOCK) {
  N = Math.ceil(N / BLOCK) * BLOCK;
  const totalP = N / BLOCK;
  let checksum = 0;
  for (let basePx = 0; basePx < totalP; basePx += CHUNK_PX) {
    const chunkP = Math.min(CHUNK_PX, totalP - basePx);
    const { TW, TH } = grid(chunkP);
    const raw = lib.raw("otranspilerl_glsl", [lowerBitOps(lowerWhileLoops(lowerBranchless(hashBlockFragmentShader(TW, basePx + chunkP, BLOCK, basePx))))], [800]).output;
    const g = collapseConsecutiveListLoop(raw);
    const glsl = packFragmentResultToRGBA(g);
    const pr = fragProgram(gl, glsl, TW, TH);
    if (pr.err) return { err: pr.err };
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(TW * TH * 4);
    gl.readPixels(0, 0, TW, TH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let part = 0;
    for (let i = 0; i < TW * TH; i++) part = checksumAdd("hash", part, decode32(px, i));
    checksum = (checksum + part) >>> 0;
  }
  return { checksum };
}

// compile C, get reference checksums
for (const [name, src] of Object.entries(C_SOURCES)) {
  writeFileSync(`/tmp/gvi_${name}.c`, src);
  execFileSync("gcc", [`/tmp/gvi_${name}.c`, "-o", `/tmp/gvi_${name}`, "-O2"], { stdio: "ignore" });
}
const N = 200000;
const BLOCK = 64;
const gl = createGL(4096, 4096, { preserveDrawingBuffer: true });
let allOk = true;
for (const name of ["collatz", "ca1d", "hash"]) {
  const cOut = execFileSync(`/tmp/gvi_${name}`, [String(N)], { stdio: "pipe" }).toString().trim();
  const r = name === "collatz" ? runCollatz(gl, N, BLOCK) : name === "ca1d" ? runCa1d(gl, N, BLOCK) : runHash(gl, N, BLOCK);
  if (r.err) { console.log(name, "GPU ERR", r.err); allOk = false; continue; }
  const ok = r.checksum === Number(cOut) >>> 0;
  console.log(`${name}: GPU checksum ${r.checksum} vs C ${cOut} → ${ok ? "MATCH" : "MISMATCH"}`);
  if (!ok) allOk = false;
}
console.log(allOk ? "ALL BLOCK-REDUCTION RUNNERS MATCH C" : "FAIL");
process.exit(allOk ? 0 : 1);
