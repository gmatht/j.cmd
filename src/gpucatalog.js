// ─── gpucatalog.js — the GPU-lift catalog: algorithms + their loaders ──
//
// The fuzzy matcher proved a repeatable recipe for moving a bash
// computation to the GPU: expose a parallel dimension as one shader
// invocation per work item (a pixel for fragment, a vertex for vertex),
// keep the body integer-compute, load the data through inline arrays or
// the texture-window lift, and pack the per-item result into the RGBA
// byte buffer (or the vc_* varyings on the vertex stage).
//
// This module is the catalog that generalises it. Each entry is a small
// bash program + a CPU reference + texel/vertex loaders + (for the
// bench) bash/C twins, sharing the fuzzy machinery (liftTextureWindowSample,
// packFragmentResultToRGBA, decodeRGBA).
//
//   FRAGMENT:
//   • collatz — the Collatz step count per number. One pixel per input;
//     the loop terminates DATA-DRIVEN (while n > 1), so each pixel runs
//     its own iteration count — the dynamic-loop pattern. Data via the
//     texture window (tex_idx = frag_x). Result = steps (RGBA pack).
//   • ca1d         — one 1D cellular-automaton step. One pixel per cell;
//     each fragment reads its THREE neighbours by reassigning tex_idx
//     between reads (the per-use sample machinery). Rule is baked data
//     (a kernel constant — recompiling per rule is the honest cost).
//     Result = next cell (RGBA pack).
//   VERTEX:
//   recordhash    — per-record hash. one VERTEX per record; the record's
//     bytes arrive through the ap_* attribute bridges, the result leaves
//     through vc_* (×1000 scale — vc = b*1000/255 + the +0.5 readback
//     decode round-trips a byte exactly), the raster slot comes from
//     auv_u/v (aUv), and the points read back like the fragment pack.
//
// Also catalogued as NOT liftable here, with the blocker named:
//   edit-distance DP      — sequential along the DP row; the cell depends
//                           on the previous cell (no parallel dimension).
//   prefix sums / scan    — data-dependent sequential dependency chain.
//   histogram scatter     — scatter to an arbitrary bin needs atomics/
//                           scatter writes (absent in ES 1.00); the
//                           bin-by-pixel readback would be hl×bins texels.
//   float Mandelbrot      — per-iteration fp math; the bc-float path is
//                           constant-folding, not per-pixel-iteration.

import { liftTextureWindowSample, packFragmentResultToRGBA, collapseConsecutiveListLoop } from "./shglsl-opt.js";
import { decodeRGBA } from "./fuzzygpu.js";

// ── 1. fragment: the Collatz step count ──────────────────────────
// one pixel per number; texel R = the number (≤ 255 — the int32
// accumulator bound: 3n+1 intermediates must stay < 2³¹; the max peak
// for n ≤ 255 is 4376, safe); the loop runs until n == 1 (data-driven
// termination); the step count is the RGBA-packed result.
export function collatzShader() {
  return [
    "tex_idx=$(( frag_x ))",            // the window index (convention)
    "n=$(( tex_r ))",                   // the value (R byte of the texel)
    "steps=0",
    "while [ $n -gt 1 ]; do",
    "    if [ $(( n % 2 )) -eq 0 ]; then",
    "        n=$(( n / 2 ))",
    "    else",
    "        n=$(( 3 * n + 1 ))",
    "    fi",
    "    steps=$(( steps + 1 ))",
    "done",
    "putb $(( steps ))",
  ].join("\n");
}

export function collatzCPU(values) {
  const steps = (n) => {
    let s = 0;
    while (n > 1) { n = n % 2 === 0 ? n / 2 : 3 * n + 1; s++; }
    return s;
  };
  return values.map(steps);
}

export function compileCollatzGLSL(rawGlsl, { width = 64, height = 1 } = {}) {
  const g = liftTextureWindowSample(rawGlsl, { width, height, highp: true });
  return { glsl: packFragmentResultToRGBA(g), fired: g !== String(rawGlsl) };
}

// the STRICT ES 1.00 collatz (the fixed-iteration fallback): the strict
// compilers reject the data-driven `while` — the loop is a CONSTANT
// maxIters `for k in <list>` with an early `break` on convergence. For
// n ≤ 255 the trajectory always converges in ≤ 111 steps < maxIters, so
// the result is identical; a non-converged pixel caps at maxIters (a
// sentinel the reader can distinguish by equality with maxIters).
export function collatzStrictShader(maxIters = 512) {
  const list = Array.from({ length: maxIters }, (_, i) => i).join(" ");
  return [
    "tex_idx=$(( frag_x ))",
    "n=$(( tex_r ))",
    "steps=0",
    "for k in " + list + "; do",
    "    if [ $n -eq 1 ]; then break; fi",
    "    if [ $(( n % 2 )) -eq 0 ]; then",
    "        n=$(( n / 2 ))",
    "    else",
    "        n=$(( 3 * n + 1 ))",
    "    fi",
    "    steps=$(( k + 1 ))",
    "done",
    "putb $(( steps ))",
  ].join("\n");
}

export function compileCollatzStrictGLSL(rawGlsl, { width = 64, height = 1 } = {}) {
  let g = liftTextureWindowSample(rawGlsl, { width, height, highp: true });
  g = collapseConsecutiveListLoop(g);   // the 512-branch if-chain → g_k = _fi
  return { glsl: packFragmentResultToRGBA(g), fired: g !== String(rawGlsl) };
}

// ── 2. fragment: one 1D cellular-automaton step ─────────────────
// one pixel per cell; the three neighbour reads reassign tex_idx
// between reads so each per-use sample hits left/mid/right (the per-use
// transform is index-agnostic); the rule is a baked array (data in the
// source — recompiling per rule is the honest cost, rules are few).
export function ca1dShader(rule = [0, 1, 1, 1, 0, 1, 1, 0]) {
  return [
    "tex_idx=$(( frag_x - 1 ))",        // left
    "left=$tex_r",
    "tex_idx=$(( frag_x ))",            // mid
    "mid=$tex_r",
    "tex_idx=$(( frag_x + 1 ))",        // right
    "right=$tex_r",
    "idx=$(( left * 4 + mid * 2 + right ))",
    "rule=(" + rule.join(" ") + ")",
    "cell=$(( rule[idx] ))",            // plain-var index → int array
    "putb $(( cell ))",
  ].join("\n");
}

export function ca1DCPU(row, rule = [0, 1, 1, 1, 0, 1, 1, 0]) {
  const w = row.length;
  return row.map((_, x) => {
    const l = row[Math.max(0, x - 1)], m = row[x], r = row[Math.min(w - 1, x + 1)];
    return rule[l * 4 + m * 2 + r];
  });
}

export function compileCa1DGLSL(rawGlsl, { width = 64, height = 1 } = {}) {
  const g = liftTextureWindowSample(rawGlsl, { width, height, highp: true });
  return { glsl: packFragmentResultToRGBA(g), fired: g !== String(rawGlsl) };
}

// the STRICT ES 1.00 ca1d: strict compilers reject dynamic ARRAY indices
// ('Index expression can only contain const or loop symbols' — verified
// in headless Chromium) AND every `while`, so the rule lookup becomes an
// arithmetic ternary over the rule's set bits (no array, no loop):
//   cell = (idx == a || idx == b || …) ? 1 : 0
export function ca1dStrictShader(rule = [0, 1, 1, 1, 0, 1, 1, 0]) {
  const set = rule.map((v, i) => (v ? i : null)).filter((v) => v !== null);
  const cond = set.map((i) => `idx == ${i}`).join(" || ");
  return [
    "tex_idx=$(( frag_x - 1 ))",
    "left=$tex_r",
    "tex_idx=$(( frag_x ))",
    "mid=$tex_r",
    "tex_idx=$(( frag_x + 1 ))",
    "right=$tex_r",
    "idx=$(( left * 4 + mid * 2 + right ))",
    `cell=$(( (${cond}) ? 1 : 0 ))`,
    "putb $(( cell ))",
  ].join("\n");
}

export function compileCa1dStrictGLSL(rawGlsl, { width = 64, height = 1 } = {}) {
  const g = liftTextureWindowSample(rawGlsl, { width, height, highp: true });
  return { glsl: packFragmentResultToRGBA(g), fired: g !== String(rawGlsl) };
}

// ── 3. vertex: per-record hash (the vertex-compute transport) ────
// ONE vertex per record. The record (3 bytes) arrives via ap_*; the
// payload leaves via vc_* — the ×1000 scale needs vc = b*1000/255
// (floor) and the readback decodes int(c*255+0.5) — an exact byte
// round-trip (verified); the raster slot comes from auv_u/v and the
// points are drawn 1px each, read back like any canvas.
export function hashVertexShader() {
  return [
    "rec_a=$ap_x",
    "rec_b=$ap_y",
    "rec_c=$ap_z",
    "res=$(( (rec_a * 31 + rec_b * 17 + rec_c * 7) % 256 ))",
    "vc_r=$(( (res * 1000) / 255 ))",
    "vc_g=$(( ((res / 256) % 256) * 1000 / 255 ))",
    "vc_b=$(( ((res / 65536) % 256) * 1000 / 255 ))",
    "vc_a=1000",
    // the raster slot from the aUv bridge; every capture must reference
    // a variable (a bare literal takes the string path and breaks the
    // vertex shader with the itos/cat do-loop helpers)
    "vp_x=$(echo \"scale=4; $auv_u / 1000.0 + 0.0\" | bc)",
    "vp_y=$(echo \"scale=4; $auv_v / 1000.0 + 0.0\" | bc)",
    "vp_z=$(echo \"scale=4; $auv_u * 0.0 + 0.0\" | bc)",
    "vp_w=$(echo \"scale=4; $auv_u * 0.0 + 1.0\" | bc)",
  ].join("\n");
}

export function hashCPU(records) {
  return records.map(([a, b, c]) => (a * 31 + b * 17 + c * 7) % 256);
}

// the vertex readback: the POINTS raster stores vColor (vc/1000) as
// normalized bytes; the value is r+256g+65536b (vc_a is the alpha
// filler, not a payload byte, so there is NO A≥128 sentinel here).
// vc = floor(b*1000/255) → texel = int(vc/1000*255+0.5) = b, exact.
export function decodeVertexBytes(px, n) {
  const scores = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    scores[i] = px[i * 4] + 256 * px[i * 4 + 1] + 65536 * px[i * 4 + 2];
  }
  return { scores, sentinels: 0 };
}

// ── texel builders (fragment inputs) ─────────────────────────────
export function texelRowData(values, width) {
  const data = new Uint8Array(width * 4);
  values.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 3] = 255; });
  return data;
}

// ── the catalog (the "think up" deliverable, machine-readable) ───
export const CATALOG = [
  {
    key: "collatz",
    stage: "fragment",
    parallel: "one pixel per input number",
    data: "uTex texture-window (tex_idx = frag_x)",
    body: "data-driven loop (while n > 1) — no fixed iteration count",
    result: "the step count, RGBA-packed",
    why: "shows per-pixel dynamic loops + the window read",
  },
  {
    key: "ca1d",
    stage: "fragment",
    parallel: "one pixel per cell of the row",
    data: "uTex texture-window; neighbours via tex_idx reassignment between reads",
    body: "fixed rule lookup (baked kernel data)",
    result: "the next-generation cell (0/1), RGBA-packed",
    why: "shows the per-use sample reading MULTIPLE texels per fragment",
  },
  {
    key: "hash",
    stage: "vertex",
    parallel: "one vertex per record",
    data: "ap_*/auv_* attribute bridges (the per-invocation input model)",
    body: "vc_* payload (×1000 → exact byte round-trip), vp_* slot via the bc-float path",
    result: "the record hash bytes, read back from the POINTS raster",
    why: "shows the vertex compute stage + the varyings output model",
  },
];
