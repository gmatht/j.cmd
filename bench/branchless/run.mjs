// ─── bench/branchless/run.mjs — prove the branchless optimisation is general ──
//
// For each algorithm in algorithms.mjs, compile the NAIVE (branchy) form and
// the auto-branchless form (lowerBranchless + selectIfElse), run both on
// headless-gl (SwiftShader), and check BOTH match the plain JS reference.
// The point is NOT the SwiftShader speed (a scalar renderer can't model warp
// divergence) — it's that the pre-passes correctly rewrite several DIFFERENT
// data-dependent branch patterns (while-escape, per-element max, conditional
// count, clamps) into arithmetic selects with identical results. The
// branchless-vs-branchy per-item cost is reported as a hint only.
//
//   node bench/branchless/run.mjs            # headless (SwiftShader)
//   node bench/branchless/run.mjs --quick    # 0.1x sizes
import { getOtranspilerl } from "../../src/otranspilerl.js";
import { packFragmentResultToRGBA, collapseConsecutiveListLoop } from "../../src/shglsl-opt.js";
import { lowerWhileLoops, lowerBitOps, lowerBranchless, selectIfElse, checksumAdd } from "../gcc-vs-igpu/c-programs.mjs";
import { ALGORITHMS } from "./algorithms.mjs";
const createGL = (await import("gl")).default;
const lib = await getOtranspilerl();

const QUICK = process.argv.includes("--quick");
const N = QUICK ? 200000 : 2000000; // items per problem
const BLOCK = 64;

const VERT = `attribute vec2 aPos; varying highp vec2 vUv;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;
function fragProgram(gl, glsl, w, h) {
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, glsl); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return { err: gl.getShaderInfoLog(fs) };
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { err: gl.getProgramInfoLog(p) };
  gl.useProgram(p);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, "aPos"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, w, h);
  return { p };
}
function decode32(px, i) { return px[i * 4] + 256 * px[i * 4 + 1] + 65536 * px[i * 4 + 2] + 16777216 * px[i * 4 + 3]; }
function grid(P) { const TW = Math.ceil(Math.sqrt(P)), TH = Math.ceil(P / TW); return { TW, TH }; }

// compile a shader source through the pipeline; branchless=true applies the
// branchless pre-passes, false keeps the branches (while -> guarded for only).
// Returns the linked program (caller must useProgram it before drawing).
function compile(gl, src, w, h, branchless, maxIter) {
  let s = src;
  if (branchless) s = lowerBitOps(lowerWhileLoops(lowerBranchless(selectIfElse(s), { maxIter })));
  else s = lowerBitOps(lowerWhileLoops(s));
  const raw = lib.raw("otranspilerl_glsl", [s], [800]).output;
  let g = collapseConsecutiveListLoop(raw); g = collapseConsecutiveListLoop(g);
  const glsl = packFragmentResultToRGBA(g);
  const pr = fragProgram(gl, glsl, w, h);
  if (pr.err) return { err: pr.err };
  return { p: pr.p };
}
function run(gl, pr, w, h) {
  gl.useProgram(pr.p);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum = checksumAdd("x", sum, decode32(px, i));
  return sum >>> 0;
}
function timeRun(gl, pr, w, h) {
  gl.useProgram(pr.p);
  gl.drawArrays(gl.TRIANGLES, 0, 3); // warmup
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(w * h * 4));
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

const Nc = Math.ceil(N / BLOCK) * BLOCK;
const P = Nc / BLOCK;
const { TW, TH } = grid(P);
const gl = createGL(TW, TH, { preserveDrawingBuffer: true });

console.log(`== branchless optimisation benchmark (headless SwiftShader, N=${Nc}, BLOCK=${BLOCK}) ==`);
console.log("problem   branch pattern                    branchy ns/it   branchless ns/it   speedup   checksums (vs JS ref)");
let allOk = true;
for (const [key, alg] of Object.entries(ALGORITHMS)) {
  const maxIter = alg.maxIter ?? 128;
  const src = alg.shader(TW, P, BLOCK, 0);
  const ref = alg.reference(Nc, BLOCK);
  const cb = compile(gl, src, TW, TH, false, maxIter);
  const cl = compile(gl, src, TW, TH, true, maxIter);
  if (cb.err) { console.log(key.padEnd(9), "BRANCHY COMPILE ERR", cb.err); allOk = false; continue; }
  if (cl.err) { console.log(key.padEnd(9), "BRANCHLESS COMPILE ERR", cl.err); allOk = false; continue; }
  const sb = run(gl, cb, TW, TH);
  const sl = run(gl, cl, TW, TH);
  const okB = sb === ref, okL = sl === ref;
  if (!okB || !okL) allOk = false;
  const tb = timeRun(gl, cb, TW, TH);
  const tl = timeRun(gl, cl, TW, TH);
  const nspB = (tb * 1e6 / Nc).toFixed(2), nspL = (tl * 1e6 / Nc).toFixed(2);
  const sp = (tb / tl).toFixed(2) + "×";
  console.log(
    key.padEnd(9),
    alg.name.padEnd(34),
    nspB.padStart(12),
    nspL.padStart(15),
    sp.padStart(9),
    `  branchy ${sb === ref ? "✓" : "✗(" + sb + "≠" + ref + ")"}  branchless ${sl === ref ? "✓" : "✗(" + sl + "≠" + ref + ")"}`
  );
}
console.log(allOk ? "\n✅ ALL ALGORITHMS MATCH THE JS REFERENCE in BOTH forms" : "\n❌ MISMATCH — see above");
process.exit(allOk ? 0 : 1);
