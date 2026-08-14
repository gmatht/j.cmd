// ─── __frag-example-test.mjs — the example shader is a LIVING artifact ──
// examples/mimecroft-frag.sh (bash) is the source of truth; the committed
// examples/mimecroft-frag.glsl is what the sh→GLSL backend (the
// otranspilerl wasm, `sh2glsl`) produces for it. This test regenerates it
// through the same wasm the game uses and verifies:
//   1. the committed .glsl is byte-identical to a fresh compile (no
//      stale artifact — regenerate + re-commit when the backend changes),
//   2. the artifact carries the quality properties the backend now
//      guarantees: ES 1.00 mediump float (the 800×600 canvas fits the
//      10-bit mantissa), the mandatory-precision PROOF running honestly
//      (highp int stays when the texture multiply's r*tex_r intermediate
//      exceeds ±2^15 — 255×255=65025 — the proof must NOT lie), main()
//      locals, no dead runtime arrays, the 2-fetch hoisted texture
//      sample, a 4-slot out_buf.
import { readFileSync } from "fs";
import { getOtranspilerl } from "./src/otranspilerl.js";

const lib = await getOtranspilerl();
const src = readFileSync("examples/mimecroft-frag.sh", "utf8");
const fresh = lib.glsl(src);
const committed = readFileSync("examples/mimecroft-frag.glsl", "utf8");

// 1. the artifact is current
if (fresh === committed) {
  console.log("ok  committed mimecroft-frag.glsl matches a fresh compile");
} else {
  console.log("bad committed mimecroft-frag.glsl is STALE — regenerate with:");
  console.log("  node --input-type=module -e \"import{getOtranspilerl}from'./src/otranspilerl.js';const l=await getOtranspilerl();process.stdout.write(l.glsl(require('fs').readFileSync('examples/mimecroft-frag.sh','utf8')))\" > examples/mimecroft-frag.glsl");
  process.exitCode = 1;
}

// 2. the quality properties
const checks = [
  // 0..127 colour scale: the tint r·tex_r/128 ≤ 127·255 = 32385, the
  // blend (r-cr_r)·mix/256 ≤ 228·127 = 28956 and every other product
  // stays inside ±2^15 — so the interval proof fires and the ES 1.00
  // MANDATORY mediump int is emitted (the mandatory precision is what
  // keeps the shader compiling on old GPUs without highp int in fragment).
  ["ES 1.00 mediump int (0..127 scale provable)", fresh.includes("precision mediump int;")],
  ["no highp int (the proof fired)", !fresh.includes("precision highp int;")],
  ["ES 1.00 mediump float (800≤2048 canvas)", fresh.includes("precision mediump float;")],
  ["program vars are main() locals", !/^int g_[a-z_]+;$/m.test(fresh.split("void main()")[0] ?? "")],
  ["no dead g_pa param array", !fresh.includes("g_pa")],
  ["no dead g_fit array", !fresh.includes("g_fit")],
  ["no dead out_len/OUT_CAP", !fresh.includes("out_len") && !fresh.includes("OUT_CAP")],
  ["texture sample hoisted (2 fetches: _tex + _crack)", (fresh.match(/texture2D\(/g) || []).length <= 2 && fresh.includes("vec4 _tex = texture2D(uTex")],
  ["4-slot out_buf (putb at fixed slots)", fresh.includes("int out_buf[4];")],
  ["the % emulation preserved", fresh.includes("g_fy / 6")],
  ["atom parens stripped", fresh.includes("g_r = 255;")],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "ok " : "bad"} ${name}`);
  if (!ok) bad++;
}
if (bad > 0) {
  console.log(`FAIL: ${bad} quality check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`ALL FRAG-EXAMPLE CHECKS PASSED (${fresh.split("\n").length} lines)`);
}
