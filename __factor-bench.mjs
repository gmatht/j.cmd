// ─── __factor-bench.mjs — the GPU-lift benchmark (factor.sh) ────
//
// The case study: www/examples/factor.sh (bash trial division) vs its C
// twin www/examples/c/factor.c vs the shader-lift patterns (batch /
// divisor-sieve — see WRITING_GPU_SHADERS_IN_BASH.md §6c). This
// benchmark measures the node-faithful half of the decision:
//
//   1. the CPU fallback cost — bash and C wall time per number;
//   2. the GPU-path fixed overhead — the bash→GLSL compile (cold) and
//      the cached re-eval (the (a) reuse win);
//   3. the lift-pattern verdicts — the batch and sieve shaders must
//      compile with 0 unsupported and be detected as worth it;
//   4. the crossover — the batch size at which the GPU path (compile +
//      render) beats the bash loop, and the bash/C speedup.
//
// The GPU render time itself is NOT measurable on node (no WebGL —
// headless-gl is SwiftShader software rendering and would mislead);
// that half belongs to the browser harness www/glsl-int-vs-float-bench.html.
// The compile overhead here is the same wasm the browser runs, so the
// fixed-cost half of the crossover is node-faithful.
//
//   node __factor-bench.mjs            → the full table
//   node __factor-bench.mjs --quick    → one run per number (CI)
//
// Exit code 0; the assertions (0 unsupported, worth it) fail loudly.

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { getShaderTranslation, analyzeShader, shaderCache } from "./src/shglsl-auto.js";

const BASH = "www/examples/factor.sh";
const C_BIN = "/tmp/factor-c";

// the numbers: a mix of small/large, composite/prime (√n = the trial-
// division iteration count)
const NUMBERS = [
  { n: "360",        note: "2³·3²·5 (small composite)" },
  { n: "999983",     note: "prime, √n ≈ 1000" },
  { n: "2147483647", note: "2³¹−1 (prime, √n ≈ 46340)" },
  { n: "999999937",  note: "prime near 1e9, √n ≈ 31623" },
  { n: "4294967296", note: "2³² (factors fast)" },
  { n: "1000000007", note: "prime near 1e9" },
];

// the two lift patterns (the restructured trial-division core)
const BATCH_SHADER = `n=$((tex_r * 65536 + tex_g * 256 + tex_b))
d=2
while [ $((d * d)) -le "$n" ]; do
    while [ $((n % d)) -eq 0 ]; do
        n=$((n / d))
    done
    d=$((d + 1))
done
putb $((n % 256))`;

const SIEVE_SHADER = `n=$((tex_r * 65536 + tex_g * 256 + tex_b))
d=$((frag_x + 1))
if [ $((n % d)) -eq 0 ]; then
    putb 255
else
    putb 0
fi`;

// time one subprocess run (wall ms, min of `runs`)
function timeRun(cmd, args, runs) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    execFileSync(cmd, args, { stdio: "ignore" });
    const dt = (performance.now() - t0) * 1000; // µs
    if (dt < best) best = dt;
  }
  return best / 1000; // ms
}

const quick = process.argv.includes("--quick");
const runs = quick ? 1 : 5;

// ── 0. build the C binary ────────────────────────────────────────
console.log("== build the C twin ==");
execFileSync("cc", ["www/examples/c/factor.c", "-o", C_BIN, "-O2"], { stdio: "ignore" });
console.log(`  cc www/examples/c/factor.c -o ${C_BIN} -O2  → ok`);

// ── 1. CPU fallback: bash vs C per number ───────────────────────
console.log("\n== CPU fallback (wall ms per number, min of " + runs + ") ==");
console.log("  " + "n".padEnd(14) + "bash".padEnd(10) + "C".padEnd(10) + "bash/C".padEnd(8) + "note");
let totalBash = 0, totalC = 0;
for (const { n, note } of NUMBERS) {
  const bashMs = timeRun("bash", [BASH, n], runs);
  const cMs = timeRun(C_BIN, [n], runs);
  totalBash += bashMs;
  totalC += cMs;
  console.log(
    `  ${n.padEnd(14)}${bashMs.toFixed(2).padEnd(10)}${cMs.toFixed(3).padEnd(10)}` +
    `${(bashMs / cMs).toFixed(1).padEnd(8)}${note}`
  );
}
console.log(`  ${"Σ".padEnd(14)}${totalBash.toFixed(2).padEnd(10)}${totalC.toFixed(3).padEnd(10)}${(totalBash / totalC).toFixed(1)}`);

// ── 2. GPU-path fixed overhead (the node-faithful half) ──────────
console.log("\n== GPU-path fixed overhead (the same wasm the browser runs) ==");
await getShaderTranslation("putb 0"); // load the wasm
shaderCache().clear();
let t0 = performance.now();
await getShaderTranslation(BATCH_SHADER);
let t1 = performance.now();
const coldMs = t1 - t0;
t0 = performance.now();
for (let i = 0; i < 200; i++) await getShaderTranslation(BATCH_SHADER);
t1 = performance.now();
const cachedMs = (t1 - t0) / 200;
console.log(`  cold compile (bash→GLSL, both stages): ${coldMs.toFixed(2)} ms`);
console.log(`  cached re-eval (per call):              ${cachedMs.toFixed(4)} ms`);

// ── 3. the lift-pattern verdicts ─────────────────────────────────
console.log("\n== lift-pattern verdicts (the detector) ==");
for (const [name, src] of [["batch", BATCH_SHADER], ["sieve", SIEVE_SHADER]]) {
  const a = await analyzeShader(src);
  const ok = a.shader && a.worth && a.report.fragment.total === 0;
  console.log(
    `  ${name.padEnd(6)} shader: ${a.shader} · kind: ${a.kind} · worth: ${a.worth}` +
    ` · unsupported: ${a.report.fragment.total} · loops: ${a.loops} · ops: ${a.ops}` +
    (ok ? "" : "  ← FAIL")
  );
  if (!ok) process.exit(1);
}

// ── 4. the crossover ─────────────────────────────────────────────
console.log("\n== crossover (where the GPU path pays) ==");
// GPU path per batch = cold compile (one-time) + render (browser-side,
// ~1 ms for a small canvas — the honest estimate) + readback.
// CPU path per batch = batch × bash wall time.
const renderEstMs = 1.0;
const perNumberBash = totalBash / NUMBERS.length;
const crossover = Math.ceil((coldMs + renderEstMs) / perNumberBash);
console.log(`  bash per number (avg):        ${perNumberBash.toFixed(2)} ms`);
console.log(`  GPU path fixed (compile+render): ${(coldMs + renderEstMs).toFixed(2)} ms`);
console.log(`  → the GPU path beats the bash loop at batch size ≥ ${crossover}`);
console.log(`  (for n = 2³¹−1 alone: bash ${timeRun("bash", [BASH, "2147483647"], 1).toFixed(0)} ms vs GPU path ${(coldMs + renderEstMs).toFixed(0)} ms — the GPU wins at batch 1)`);
console.log("\nThe render half (per-pixel ALU, draw+readback) is browser-side — measure it with www/glsl-int-vs-float-bench.html on a real GPU.");
