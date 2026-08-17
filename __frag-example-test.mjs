// ─── __frag-example-test.mjs — the example shader is a LIVING artifact ──
// www/examples/mimecroft-frag.sh (bash) is the source of truth; the committed
// www/examples/mimecroft-frag.glsl is what the sh→GLSL backend (the
// otranspilerl wasm, `sh2glsl`) produces for it. This test regenerates it
// through the same wasm the game uses and verifies:
//   1. the committed .glsl is byte-identical to a fresh compile (no
//      stale artifact — regenerate + re-commit when the backend changes),
//   2. the artifact carries the quality properties the pipeline now
//      guarantees: ES 1.00 mediump float (the 800×600 canvas fits the
//      10-bit mantissa), the mandatory-precision PROOF running honestly
//      (mediump int stays — the 0..127 scale bounds every product inside
//      ±2^15, the proof must NOT lie), main() locals, no dead runtime
//      arrays, the 2-fetch hoisted texture sample, and the shglsl-opt
//      lowering: exact float modulos + a float-native colour chain.
import { readFileSync } from "fs";
import { getOtranspilerl } from "./src/otranspilerl.js";

const lib = await getOtranspilerl();
const src = readFileSync("www/examples/mimecroft-frag.sh", "utf8");
const fresh = lib.glsl(src);
const committed = readFileSync("www/examples/mimecroft-frag.glsl", "utf8");

// 1. the artifact is current
if (fresh === committed) {
  console.log("ok  committed mimecroft-frag.glsl matches a fresh compile");
} else {
  console.log("bad committed mimecroft-frag.glsl is STALE — regenerate with:");
  console.log("  node --input-type=module -e \"import{getOtranspilerl}from'./src/otranspilerl.js';const l=await getOtranspilerl();process.stdout.write(l.glsl(require('fs').readFileSync('www/examples/mimecroft-frag.sh','utf8')))\" > www/examples/mimecroft-frag.glsl");
  process.exitCode = 1;
}

// 2. the quality properties — the shglsl-opt.js pass now lowers the
//    wasm's fixed-point output: the two constant modulos become exact
//    float mods (int(mod(float(), d)) — bit-identical for x<2^24) and
//    the colour chain runs in native mediump float (no int-div
//    emulation; the 0..127/0..255 quantize boundaries are preserved).
const checks = [
  // the 0..127 colour scale: the tint r·tex_r/128 ≤ 127·255 = 32385
  // stays inside ±2^15 — so the interval proof fires and ES 1.00
  // MANDATORY mediump int is emitted (keeps the shader compiling on
  // old GPUs without highp int in fragment).
  ["ES 1.00 mediump int (0..127 scale provable)", fresh.includes("precision mediump int;")],
  ["no highp int (the proof fired)", !fresh.includes("precision highp int;")],
  ["ES 1.00 mediump float (800≤2048 canvas)", fresh.includes("precision mediump float;")],
  ["program vars are main() locals", !/^(?:int|float) g_[a-z_]+;$/m.test(fresh.split("void main()")[0] ?? "")],
  ["no dead g_pa param array", !fresh.includes("g_pa")],
  ["no dead g_fit array", !fresh.includes("g_fit")],
  ["no dead out_len/OUT_CAP", !fresh.includes("out_len") && !fresh.includes("OUT_CAP")],
  ["texture sample hoisted (2 fetches: _tex + _crack)", (fresh.match(/texture2D\(/g) || []).length <= 2 && fresh.includes("vec4 _tex = texture2D(uTex")],
  ["no int out_buf (the float chain writes gl_FragColor directly)", !fresh.includes("out_buf")],
  ["the modulos lowered to exact float mods", fresh.includes("int(mod(float(g_frag_y), 6.0))") && fresh.includes("int(mod(float(g_hash), 97.0))")],
  ["float-native colour chain (no int tint div)", fresh.includes("float g_r;") && !fresh.includes("g_r * g_tex_r")],
  ["atom parens stripped", fresh.includes("g_r = 255.0;")],
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
