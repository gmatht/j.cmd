// ─── gl-catalog-gate.mjs — the GPU-lift catalog on headless-gl ──
// The REAL transformed shaders for the catalog algorithms (collatz,
// ca1d, recordhash), run on headless-gl (SwiftShader). Equality only —
// timing would mislead. Every case must reproduce the CPU reference
// exactly (0 sentinels); imported by __gpu-catalog-bench.mjs; also
// runnable standalone:  node gl-catalog-gate.mjs  (exit 0 on all pass)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createGL = require("gl");

const VERT = `
attribute vec2 aPos;
varying highp vec2 vUv;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;

function texelTexture(gl, values, width) {
  const data = new Uint8Array(width * 4);
  values.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 3] = 255; });
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function fragProgram(gl, fragSrc, width) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fragSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error("frag: " + gl.getShaderInfoLog(fs));
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const loc = gl.getUniformLocation(prog, "uTex"); if (loc) gl.uniform1i(loc, 0);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, width, 1);
  return prog;
}

function readScores(gl, prog, width, decodeRGBA) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(width * 4);
  gl.readPixels(0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return decodeRGBA(px, width);
}

export async function run(deps) {
  const {
    lib,
    collatzShader, compileCollatzGLSL, collatzCPU,
    ca1dShader, compileCa1DGLSL, ca1DCPU,
    hashVertexShader, hashCPU, injectPointSize,
    decodeRGBA,
  } = deps;
  const failures = [];

  // ── 1. collatz: fragment, data-driven loop ──
  {
    const values = [1, 7, 27, 255, 64, 97, 3, 129];
    const W = values.length;
    const raw = lib.raw("otranspilerl_glsl", [collatzShader()], [800]).output;
    const { glsl, fired } = compileCollatzGLSL(raw, { width: W });
    if (!fired) throw new Error("collatz transform did not fire");
    const gl = createGL(W, 1, { preserveDrawingBuffer: true });
    gl.bindTexture(gl.TEXTURE_2D, texelTexture(gl, values, W));
    const prog = fragProgram(gl, glsl, W);
    const { scores, sentinels } = readScores(gl, prog, W, decodeRGBA);
    const want = collatzCPU(values);
    const ok = scores.every((v, i) => v === want[i]) && sentinels === 0;
    console.log(`  collatz: got=[${[...scores].join(",")}] want=[${want.join(",")}] ==cpu ${ok ? "PASS" : "FAIL"} sentinels ${sentinels}`);
    if (!ok) failures.push("collatz");
  }

  // ── 2. ca1d: one rule-118 step, three neighbours per fragment ──
  {
    const W = 64;
    const row = new Array(W).fill(0);
    row[7] = 1; row[19] = 1; row[26] = 1; row[44] = 1;
    const rule = [0, 1, 1, 1, 0, 1, 1, 0]; // 118
    const raw = lib.raw("otranspilerl_glsl", [ca1dShader(rule)], [800]).output;
    const { glsl, fired } = compileCa1DGLSL(raw, { width: W });
    if (!fired) throw new Error("ca1d transform did not fire");
    const gl = createGL(W, 1, { preserveDrawingBuffer: true });
    gl.bindTexture(gl.TEXTURE_2D, texelTexture(gl, row, W));
    const prog = fragProgram(gl, glsl, W);
    const { scores, sentinels } = readScores(gl, prog, W, decodeRGBA);
    const want = ca1DCPU(row, rule);
    const ok = scores.every((v, i) => v === want[i]) && sentinels === 0;
    console.log(`  ca1d: seeds at 7,19,26,44 → next row [${[...scores].join("")}] ?== cpu ${ok ? "PASS" : "FAIL"} sentinels ${sentinels}`);
    if (!ok) failures.push("ca1d");
  }

  // ── 3. hash: per-record vertex compute + POINTS readback ──
  {
    const records = [[7, 3, 9], [0, 0, 0], [255, 255, 255], [100, 200, 50], [13, 29, 17], [1, 2, 3], [250, 1, 1], [64, 64, 64]];
    const N = records.length;
    const raw = injectPointSize(lib.raw("otranspilerl_glslv", [hashVertexShader()], [800]).output, 3.0);
    const W2 = N * 2; // stride-2 point transport (a 3px point per record, read every 2nd pixel)
                            // aUv.x = exact integer slot i*2, aUv.y = W2 (see hashVertexShader)
    const gl = createGL(W2, 1, { preserveDrawingBuffer: true });
    const FRAG = `precision mediump float;
varying highp vec4 vColor;
void main(){ gl_FragColor = vColor; }`;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, raw); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error("vertex: " + gl.getShaderInfoLog(vs));
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FRAG); gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const aPos = new Float32Array(N * 3);
    records.forEach((r, i) => { aPos[i * 3] = (r[0] + 0.5) / 1000; aPos[i * 3 + 1] = (r[1] + 0.5) / 1000; aPos[i * 3 + 2] = (r[2] + 0.5) / 1000; }); // (v+0.5)/1000 → int(x*1000)=v exactly
    const aUv = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { aUv[i * 2] = i * 2 + 0.5; aUv[i * 2 + 1] = W2; }
    const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1);
    gl.bufferData(gl.ARRAY_BUFFER, aPos, gl.STATIC_DRAW);
    const a1 = gl.getAttribLocation(prog, "aPosition");
    gl.enableVertexAttribArray(a1); gl.vertexAttribPointer(a1, 3, gl.FLOAT, false, 0, 0);
    const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2);
    gl.bufferData(gl.ARRAY_BUFFER, aUv, gl.STATIC_DRAW);
    const a2 = gl.getAttribLocation(prog, "aUv");
    gl.enableVertexAttribArray(a2); gl.vertexAttribPointer(a2, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, W2, 1);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, N);
    const px = new Uint8Array(W2 * 4);
    gl.readPixels(0, 0, W2, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const scores = new Int32Array(N);
    for (let i = 0; i < N; i++) scores[i] = px[i * 2 * 4] + 256 * px[i * 2 * 4 + 1] + 65536 * px[i * 2 * 4 + 2];
    const want = hashCPU(records);
    const ok = scores.every((v, i) => v === want[i]);
    console.log(`  hash: got=[${[...scores].join(",")}] want=[${want.join(",")}] ?== cpu ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures.push("hash");
  }

  // Wide-canvas hash stress: the backend's int(aUv*1000)/1000 position
  // bridge drifts by ~0.0005*W2 px and (with 3px points at stride-2) hands
  // the read pixel the NEIGHBOUR's varying past i≈W/2 — reproduced FAIL on
  // SwiftShader at W=800 before the exact-slot fix. Keep W >= 800 so this
  // guard actually exercises the bug it's meant to prevent.
  {
    const N = 800;
    const records = Array.from({ length: N }, (_, i) => [(i * 53) % 256, (i * 89) % 256, (i * 127) % 256]);
    const raw = injectPointSize(lib.raw("otranspilerl_glslv", [hashVertexShader()], [800]).output, 3.0);
    const W2 = N * 2;
    const gl = createGL(W2, 1, { preserveDrawingBuffer: true });
    const FRAG = `precision mediump float;
varying highp vec4 vColor;
void main(){ gl_FragColor = vColor; }`;
    const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, raw); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error("vertex: " + gl.getShaderInfoLog(vs));
    const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, FRAG); gl.compileShader(fs);
    const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const aPos = new Float32Array(N * 3);
    records.forEach((r, i) => { aPos[i * 3] = (r[0] + 0.5) / 1000; aPos[i * 3 + 1] = (r[1] + 0.5) / 1000; aPos[i * 3 + 2] = (r[2] + 0.5) / 1000; });
    const aUv = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { aUv[i * 2] = i * 2 + 0.5; aUv[i * 2 + 1] = W2; }
    const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, aPos, gl.STATIC_DRAW);
    const a1 = gl.getAttribLocation(prog, "aPosition"); gl.enableVertexAttribArray(a1); gl.vertexAttribPointer(a1, 3, gl.FLOAT, false, 0, 0);
    const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2); gl.bufferData(gl.ARRAY_BUFFER, aUv, gl.STATIC_DRAW);
    const a2 = gl.getAttribLocation(prog, "aUv"); gl.enableVertexAttribArray(a2); gl.vertexAttribPointer(a2, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, W2, 1); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, N);
    const px = new Uint8Array(W2 * 4); gl.readPixels(0, 0, W2, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const scores = new Int32Array(N);
    for (let i = 0; i < N; i++) scores[i] = px[i * 2 * 4] + 256 * px[i * 2 * 4 + 1] + 65536 * px[i * 2 * 4 + 2];
    const want = hashCPU(records);
    const ok = scores.every((v, i) => v === want[i]);
    console.log(`  hash-stress W=${N}: ${ok ? "PASS" : "FAIL"} (${scores.filter((v, i) => v !== want[i]).length} mismatches)`);
    if (!ok) failures.push("hash-stress");
  }

  // ── 4. the STRICT ES 1.00 variants (fixed-iteration loop / arithmetic
  // rule) — the documented fallbacks for compilers that reject dynamic
  // loops AND dynamic array indices (verified in headless Chromium).
  {
    const values = [1, 7, 27, 255, 64, 97];
    const raw = lib.raw("otranspilerl_glsl", [deps.collatzStrictShader(512)], [800]).output;
    const { glsl, fired } = deps.compileCollatzStrictGLSL(raw, { width: 6 });
    if (!fired) throw new Error("strict collatz transform did not fire");
    const gl = createGL(6, 1, { preserveDrawingBuffer: true });
    const data = new Uint8Array(6 * 4);
    values.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 3] = 255; });
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 6, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const pr = fragProgram(gl, glsl, 6);
    const { scores, sentinels } = readScores(gl, pr, 6, decodeRGBA);
    const want = deps.collatzCPU(values);
    const ok = scores.every((v, i) => v === want[i]) && sentinels === 0;
    console.log(`  collatz-strict: got=[${[...scores].join(",")}] ==cpu ${ok ? "PASS" : "FAIL"} sentinels ${sentinels}`);
    if (!ok) failures.push("collatz-strict");

    // the n=0 regression: the strict loop's break must be the negation of
    // the original `while n > 1` (n ≤ 1), or n=0 runs all 512 iterations
    {
      const values = Array.from({ length: 256 }, (_, i) => (i * 37 + 3) % 251); // includes 0
      const raw0 = lib.raw("otranspilerl_glsl", [deps.collatzStrictShader(512)], [800]).output;
      const { glsl: glsl0 } = deps.compileCollatzStrictGLSL(raw0, { width: 256 });
      const gl0 = createGL(256, 1, { preserveDrawingBuffer: true });
      const d0 = new Uint8Array(256 * 4);
      values.forEach((v, i) => { d0[i * 4] = v; d0[i * 4 + 3] = 255; });
      const t0 = gl0.createTexture(); gl0.bindTexture(gl0.TEXTURE_2D, t0);
      gl0.pixelStorei(gl0.UNPACK_ALIGNMENT, 1);
      gl0.texImage2D(gl0.TEXTURE_2D, 0, gl0.RGBA, 256, 1, 0, gl0.RGBA, gl0.UNSIGNED_BYTE, d0);
      gl0.texParameteri(gl0.TEXTURE_2D, gl0.TEXTURE_MIN_FILTER, gl0.NEAREST);
      gl0.texParameteri(gl0.TEXTURE_2D, gl0.TEXTURE_MAG_FILTER, gl0.NEAREST);
      const pr0 = fragProgram(gl0, glsl0, 256);
      const { scores: s0 } = readScores(gl0, pr0, 256, decodeRGBA);
      const w0 = deps.collatzCPU(values);
      const ok0 = [...s0].every((v, i) => v === w0[i]);
      console.log(`  collatz-strict n=0 regression (W=256): ${ok0 ? "PASS" : "FAIL"}`);
      if (!ok0) failures.push("collatz-strict-n0");
    }
    const W = 32;
    const row = new Array(W).fill(0); row[7] = 1; row[19] = 1; row[26] = 1;
    const rule = [0, 1, 1, 1, 0, 1, 1, 0];
    const raw2 = lib.raw("otranspilerl_glsl", [deps.ca1dStrictShader(rule)], [800]).output;
    const { glsl: glsl2 } = deps.compileCa1dStrictGLSL(raw2, { width: W });
    const gl2 = createGL(W, 1, { preserveDrawingBuffer: true });
    const data2 = new Uint8Array(W * 4);
    row.forEach((v, i) => { data2[i * 4] = v; data2[i * 4 + 3] = 255; });
    const tex2 = gl2.createTexture(); gl2.bindTexture(gl2.TEXTURE_2D, tex2);
    gl2.pixelStorei(gl2.UNPACK_ALIGNMENT, 1);
    gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, W, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, data2);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.NEAREST);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.NEAREST);
    const pr2 = fragProgram(gl2, glsl2, W);
    const { scores: s2 } = readScores(gl2, pr2, W, decodeRGBA);
    const want2 = deps.ca1DCPU(row, rule);
    const ok2 = [...s2].every((v, i) => v === want2[i]);
    console.log(`  ca1d-strict: next-row == cpu ${ok2 ? "PASS" : "FAIL"}`);
    if (!ok2) failures.push("ca1d-strict");
  }

  return failures.length === 0 ? true : failures.join(", ");
}

function hashShaderSrc() {
  // unused placeholder — removed
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = await import("./src/otranspilerl.js").then((m) => ({ lib: m.getOtranspilerl() }));
  deps.lib = await deps.lib;
  const c = await import("./src/gpucatalog.js");
  for (const k of ["collatzShader", "compileCollatzGLSL", "collatzStrictShader", "compileCollatzStrictGLSL", "collatzCPU", "ca1dShader", "compileCa1DGLSL", "ca1dStrictShader", "compileCa1dStrictGLSL", "ca1DCPU", "hashVertexShader", "hashCPU"]) deps[k] = c[k];
  const f = await import("./src/fuzzygpu.js");
  deps.decodeRGBA = f.decodeRGBA;
  deps.decodeVertexBytes = c.decodeVertexBytes;
  const o = await import("./src/shglsl-opt.js");
  deps.injectPointSize = o.injectPointSize;
  const res = await run(deps);
  console.log(res === true ? "CATALOG GL GATE: PASS" : "CATALOG GL GATE: FAIL " + res);
  process.exit(res === true ? 0 : 1);
}
