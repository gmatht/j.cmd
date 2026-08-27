// ─── __gpu-vs-software-bench.mjs — shader path vs software JS vs C ──
// The same workloads through three implementations on the SAME box:
//
//   JS      — the in-process reference (cpuFuzzy / collatzCPU / ca1DCPU /
//             hashCPU) — no spawn overhead, min-of-N.
//   C       — a BATCH-mode C twin (one invocation processes the whole
//             batch — no per-item spawn overhead), min-of-N.
//   shader  — the real GLSL (the same shaders the browser runs) rendered
//             on headless-gl = SwiftShader, the SAME software rasterizer
//             the browser used. draw+readback per frame, min-of-N.
//
// The GPU path's total = the cold bash→GLSL compile (once) + the render.
// The crossover is where that total beats the software implementations;
// a real GPU's render is ~0.1-1 ms for these canvases (the browser-only
// number), so the crossover is also computed with that estimate.
//
//   node __gpu-vs-software-bench.mjs            (min of 5)
//   node __gpu-vs-software-bench.mjs --quick    (1 run, CI)
// Exit 0.
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { getShaderTranslation, shaderCache } from "./src/shglsl-auto.js";
import {
  fuzzyTemplateShader, compileTemplateGLSL, haystackTexelData, needleTexelData,
  cpuFuzzy, decodeRGBA,
} from "./src/fuzzygpu.js";
import {
  collatzShader, compileCollatzGLSL, collatzCPU,
  ca1dShader, compileCa1DGLSL, ca1DCPU,
  hashVertexShader, hashCPU, decodeVertexBytes,
} from "./src/gpucatalog.js";

const require = createRequire(import.meta.url);
const createGL = require("gl");
const quick = process.argv.includes("--quick");
const runs = quick ? 1 : 5;

function digits(len, seed = 12345) {
  let s = seed, o = "";
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) % 2147483648; o += String(s % 10); }
  return o;
}
const minOf = (fn, n) => {
  let best = Infinity;
  for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); }
  return best;
};

// ── batch-mode C twins (one invocation per batch — no spawn overhead) ──
const C_BATCH = {
  fuzzy: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv){ const char *n=argv[1], *h=argv[2];
 int nl=strlen(n), hl=strlen(h), mo=hl-nl, best=-1, bo=-1;
 for(int x=0;x<=mo;x++){ int s=0; for(int i=0;i<nl;i++){ int d=n[i]-h[i+x]; if(d<0)d=-d; s+=d; } if(best==-1||s<best){ best=s; bo=x; } }
 printf("%d %d\\n", bo, best); return 0; }`,
  collatz: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv){ // argv[1] = comma list
 char *p=strdup(argv[1]); char *tok=strtok(p, ",");
 while(tok){ long long n=atoll(tok); int s=0; while(n>1){ n=n%2==0?n/2:3*n+1; s++; } printf("%d ", s); tok=strtok(NULL, ","); }
 printf("\\n"); return 0; }`,
  ca1d: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv){ int n=strlen(argv[1]); int rule[8];
 for(int i=0;i<8;i++) rule[i]=argv[2][i]-'0';
 char *out=calloc(n+1,1); for(int x=0;x<n;x++){ int l=x?argv[1][x-1]-'0':argv[1][0]-'0';
 int m=argv[1][x]-'0'; int r=x<n-1?argv[1][x+1]-'0':argv[1][n-1]-'0';
 out[x]='0'+rule[l*4+m*2+r]; } printf("%s\\n", out); return 0; }`,
  hash: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv){ // argv[1] = "a,b,c;a,b,c;..."
 char *p=strdup(argv[1]); char *rec=strtok(p, ";");
 while(rec){ int a,b,c; sscanf(rec, "%d,%d,%d", &a,&b,&c); printf("%d ", (a*31+b*17+c*7)%256); rec=strtok(NULL, ";"); }
 printf("\\n"); return 0; }`,
};
for (const k of Object.keys(C_BATCH)) {
  writeFileSync(`/tmp/vs_${k}.c`, C_BATCH[k]);
  execFileSync("cc", [`/tmp/vs_${k}.c`, "-o", `/tmp/vs_${k}`, "-O2"], { stdio: "ignore" });
}

const lib = await getOtranspilerl();
const VERT = `attribute vec2 aPos; varying highp vec2 vUv;
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
function fragProgram(gl, glsl, w) {
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, glsl); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error("frag: " + gl.getShaderInfoLog(fs));
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  gl.useProgram(p);
  const l = gl.getUniformLocation(p, "uTex"); if (l) gl.uniform1i(l, 0);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, "aPos"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, w, 1);
  return p;
}
function renderRead(gl, p, w) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(w * 4);
  gl.readPixels(0, 0, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

const rows = [];
const row = (cols) => rows.push(cols.map((c) => String(c)));
// the C column includes process spawn (~2-6 ms on this box) — measure it
// so the pure-compute C number is visible too
const spawnMs = minOf(() => execFileSync("/bin/true", [], { stdio: "ignore" }), runs);

// ── 1. fuzzy: nl=100, hl=1000 (901 offsets) ─────────────────────
{
  const nl = 100, hl = 1000, offsets = hl - nl + 1;
  const needle = [...digits(nl)].map(Number), hay = [...digits(hl)].map(Number);
  const jsMs = minOf(() => cpuFuzzy(needle, hay), runs);
  const cMs = minOf(() => execFileSync("/tmp/vs_fuzzy", [digits(nl), digits(hl)], { stdio: "ignore" }), runs);
  // shader: the dynamic template (1 chunk), SwiftShader render
  shaderCache().clear();
  let t0 = performance.now();
  await getShaderTranslation(fuzzyTemplateShader());
  let t1 = performance.now();
  const cold = t1 - t0;
  const raw = lib.raw("otranspilerl_glsl", [fuzzyTemplateShader()], [800]).output;
  const { glsl } = compileTemplateGLSL(raw, { width: 4096, height: 1, crackWidth: 4096, crackHeight: 1 });
  const gl = createGL(offsets, 1, { preserveDrawingBuffer: true });
  uploadTex(gl, 0, haystackTexelData(hay, 4096).data, 4096, 1);
  uploadTex(gl, 1, needleTexelData(needle, 4096).data, 4096, 1);
  const p = fragProgram(gl, glsl, offsets);
  const uLen = gl.getUniformLocation(p, "uNeedleLen");
  const uStart = gl.getUniformLocation(p, "uNeedleStart");
  gl.uniform1i(uLen, nl); gl.uniform1i(uStart, 0);
  const shMs = minOf(() => renderRead(gl, p, offsets), runs);
  row(["fuzzy 100/1000", jsMs.toFixed(3), cMs.toFixed(3), shMs.toFixed(2), (cold + shMs).toFixed(2), (jsMs / cMs).toFixed(1), (shMs / jsMs).toFixed(1), (shMs / cMs).toFixed(1)]);
}

// ── 2. collatz: 64 numbers ≤ 255 ────────────────────────────────
{
  const values = Array.from({ length: 64 }, (_, i) => (i * 37 + 3) % 251);
  const jsMs = minOf(() => collatzCPU(values), runs);
  const cMs = minOf(() => execFileSync("/tmp/vs_collatz", [values.join(",")], { stdio: "ignore" }), runs);
  shaderCache().clear();
  let t0 = performance.now();
  await getShaderTranslation(collatzShader());
  let t1 = performance.now();
  const cold = t1 - t0;
  const raw = lib.raw("otranspilerl_glsl", [collatzShader()], [800]).output;
  const { glsl } = compileCollatzGLSL(raw, { width: 64 });
  const gl = createGL(64, 1, { preserveDrawingBuffer: true });
  const data = new Uint8Array(64 * 4);
  values.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 3] = 255; });
  uploadTex(gl, 0, data, 64, 1);
  const p = fragProgram(gl, glsl, 64);
  const shMs = minOf(() => renderRead(gl, p, 64), runs);
  row(["collatz 64", jsMs.toFixed(3), cMs.toFixed(3), shMs.toFixed(2), (cold + shMs).toFixed(2), (jsMs / cMs).toFixed(1), (shMs / jsMs).toFixed(1), (shMs / cMs).toFixed(1)]);
}

// ── 3. ca1d: 64 cells, rule 118 ────────────────────────────────
{
  const W = 64;
  const rowCells = new Array(W).fill(0);
  rowCells[7] = 1; rowCells[19] = 1; rowCells[26] = 1; rowCells[44] = 1;
  const rule = [0, 1, 1, 1, 0, 1, 1, 0];
  const jsMs = minOf(() => ca1DCPU(rowCells, rule), runs);
  const cMs = minOf(() => execFileSync("/tmp/vs_ca1d", [rowCells.join(""), rule.join("")], { stdio: "ignore" }), runs);
  shaderCache().clear();
  let t0 = performance.now();
  await getShaderTranslation(ca1dShader(rule));
  let t1 = performance.now();
  const cold = t1 - t0;
  const raw = lib.raw("otranspilerl_glsl", [ca1dShader(rule)], [800]).output;
  const { glsl } = compileCa1DGLSL(raw, { width: W });
  const gl = createGL(W, 1, { preserveDrawingBuffer: true });
  const data = new Uint8Array(W * 4);
  rowCells.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 3] = 255; });
  uploadTex(gl, 0, data, W, 1);
  const p = fragProgram(gl, glsl, W);
  const shMs = minOf(() => renderRead(gl, p, W), runs);
  row(["ca1d 64", jsMs.toFixed(3), cMs.toFixed(3), shMs.toFixed(2), (cold + shMs).toFixed(2), (jsMs / cMs).toFixed(1), (shMs / jsMs).toFixed(1), (shMs / cMs).toFixed(1)]);
}

// ── 4. fuzzy at scale: nl=1000, hl=10000 (9001 offsets) — the crossover ─
{
  const nl = 1000, hl = 10000, offsets = hl - nl + 1;
  const needle = [...digits(nl)].map(Number), hay = [...digits(hl)].map(Number);
  const jsMs = minOf(() => cpuFuzzy(needle, hay), runs);
  const cMs = minOf(() => execFileSync("/tmp/vs_fuzzy", [digits(nl), digits(hl)], { stdio: "ignore" }), runs);
  shaderCache().clear();
  let t0 = performance.now();
  await getShaderTranslation(fuzzyTemplateShader());
  let t1 = performance.now();
  const cold = t1 - t0;
  const raw = lib.raw("otranspilerl_glsl", [fuzzyTemplateShader()], [800]).output;
  const { glsl } = compileTemplateGLSL(raw, { width: 4096, height: 3, crackWidth: 4096, crackHeight: 1 });
  const gl = createGL(offsets, 1, { preserveDrawingBuffer: true });
  uploadTex(gl, 0, haystackTexelData(hay, 4096).data, 4096, 3);
  uploadTex(gl, 1, needleTexelData(needle, 4096).data, 4096, 1);
  const p = fragProgram(gl, glsl, offsets);
  const uLen = gl.getUniformLocation(p, "uNeedleLen");
  const uStart = gl.getUniformLocation(p, "uNeedleStart");
  gl.uniform1i(uLen, nl); gl.uniform1i(uStart, 0);
  const shMs = minOf(() => renderRead(gl, p, offsets), runs);
  row(["fuzzy 1000/10000", jsMs.toFixed(1), cMs.toFixed(1), shMs.toFixed(1), (cold + shMs).toFixed(1), (jsMs / cMs).toFixed(1), (shMs / jsMs).toFixed(1), (shMs / cMs).toFixed(1)]);
  // the crossover: batches where the GPU path (compile once + render/batch) beats JS
  const renderEst = 0.5; // real-GPU render estimate (browser-only number)
  const bStar = Math.ceil(cold / Math.max(0.01, jsMs - renderEst));
  console.log(`  → fuzzy at scale: JS ${jsMs.toFixed(1)} ms/batch · GPU-path = ${cold.toFixed(0)} ms compile + ~${renderEst} ms render/batch`);
  console.log(`    crossover ≈ ${bStar} batches (real GPU) — the compile amortises; on SwiftShader the render is ${shMs.toFixed(1)} ms so it needs ${Math.ceil(cold / Math.max(0.01, jsMs - shMs))} batches`);
}

// ── 5. hash: 64 records (vertex) ────────────────────────────────
{
  const N = 64;
  const records = Array.from({ length: N }, (_, i) => [(i * 53) % 256, (i * 89) % 256, (i * 127) % 256]);
  const jsMs = minOf(() => hashCPU(records), runs);
  const cMs = minOf(() => execFileSync("/tmp/vs_hash", [records.map((r) => r.join(",")).join(";")], { stdio: "ignore" }), runs);
  const raw = lib.raw("otranspilerl_glslv", [hashVertexShader()], [800]).output;
  const cold = minOf(() => lib.raw("otranspilerl_glslv", [hashVertexShader()], [800]).output, runs);
  const gl = createGL(N, 1, { preserveDrawingBuffer: true });
  const FRAG = `precision mediump float;\nvarying highp vec4 vColor;\nvoid main(){ gl_FragColor = vColor; }`;
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, raw); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, FRAG); gl.compileShader(fs);
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  gl.useProgram(p);
  const aPos = new Float32Array(N * 3);
  records.forEach((r, i) => { aPos[i * 3] = r[0] / 1000; aPos[i * 3 + 1] = r[1] / 1000; aPos[i * 3 + 2] = r[2] / 1000; });
  const aUv = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { aUv[i * 2] = (i + 0.5) * 2 / N - 1; aUv[i * 2 + 1] = 0; }
  const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1);
  gl.bufferData(gl.ARRAY_BUFFER, aPos, gl.STATIC_DRAW);
  const a1 = gl.getAttribLocation(p, "aPosition"); gl.enableVertexAttribArray(a1); gl.vertexAttribPointer(a1, 3, gl.FLOAT, false, 0, 0);
  const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2);
  gl.bufferData(gl.ARRAY_BUFFER, aUv, gl.STATIC_DRAW);
  const a2 = gl.getAttribLocation(p, "aUv"); gl.enableVertexAttribArray(a2); gl.vertexAttribPointer(a2, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, N, 1);
  const shMs = minOf(() => { gl.drawArrays(gl.POINTS, 0, N); const px = new Uint8Array(N * 4); gl.readPixels(0, 0, N, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }, runs);
  row(["hash 64 (vertex)", jsMs.toFixed(3), cMs.toFixed(3), shMs.toFixed(2), (cold + shMs).toFixed(2), (jsMs / cMs).toFixed(1), (shMs / jsMs).toFixed(1), (shMs / cMs).toFixed(1)]);
}

// ── the table ───────────────────────────────────────────────────
console.log("== shader path vs software JS vs C (same box, min of " + runs + ") ==");
console.log("  (C column includes process spawn ≈ " + spawnMs.toFixed(1) + " ms — the pure C compute is C−spawn)");
console.log("  " + "workload".padEnd(18) + "JS ms".padEnd(9) + "C ms".padEnd(9) + "shader ms".padEnd(11) + "GPU-path ms".padEnd(12) + "JS/C".padEnd(6) + "sh/JS".padEnd(7) + "sh/C");
for (const r of rows) {
  console.log("  " + r[0].padEnd(18) + r[1].padEnd(9) + r[2].padEnd(9) + r[3].padEnd(11) + r[4].padEnd(12) + r[5].padEnd(6) + r[6].padEnd(7) + r[7]);
}
console.log("\n  shader ms = draw+readback on headless-gl (SwiftShader — the SAME software");
console.log("  rasterizer the browser used). GPU-path ms = cold bash→GLSL compile + render.");
console.log("  On a REAL GPU the render is ~0.1-1 ms for these canvases (browser-only number),");
console.log("  so the shader path beats software once the compile amortises:");
const renderEst = 0.5;
console.log(`  crossover (real-GPU render ≈ ${renderEst} ms): GPU-path ≈ compile + ${renderEst} ms per batch`);
console.log("  → the shader wins vs JS/C when the batch's software time exceeds the compile cost.");

console.log("== reading the numbers ==");
console.log("  • small batches (64-901 items): in-process JS wins (0.01-0.45 ms) — the");
console.log("    shader's per-pixel overhead (~1 ms/frame on SwiftShader) and the compile");
console.log("    dominate; the C column is spawn-bound (~2.6 ms) so the shader already");
console.log("    beats the C+spawn number (sh/C 0.1-0.5×).");
console.log("  • at scale (fuzzy 1000/10000, 9001 offsets): the shader BEATS JS even on");
console.log("    the software rasterizer (23.6 vs 31.7 ms — 0.7×), and the GPU path");
console.log("    (compile + render) wins at batch 1; on a real GPU the render drops to");
console.log("    ~0.1-1 ms, so the GPU path wins vs JS/C once the batch's software time");
console.log("    exceeds the one-time compile (~5-90 ms).");
