// ─── __frag-example-test.mjs — the example shader is a LIVING artifact ──
// examples/mimecroft-frag.sh (bash) is the source of truth; the committed
// examples/mimecroft-frag.glsl is what the sh→GLSL backend (the
// otranspilerl wasm, `sh2glsl`) produces for it. This test regenerates it
// through the same wasm the game uses and verifies:
//   1. the committed .glsl is byte-identical to a fresh compile (no
//      stale artifact — regenerate + re-commit when the backend changes),
//   2. the artifact carries the quality properties the backend now
//      guarantees: ES 1.00 mediump precision (the interval proof passed
//      at the 800×600 canvas), main() locals, no dead runtime arrays,
//      no texture machinery, a 4-slot out_buf.
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
  ["ES 1.00 mediump int (provable)", fresh.includes("precision mediump int;")],
  ["ES 1.00 mediump float (800≤2048 canvas)", fresh.includes("precision mediump float;")],
  ["no highp int (the proof fired)", !fresh.includes("precision highp int;")],
  ["program vars are main() locals", !/^int g_[a-z_]+;$/m.test(fresh.split("void main()")[0] ?? "")],
  ["no dead g_pa param array", !fresh.includes("g_pa")],
  ["no dead g_fit array", !fresh.includes("g_fit")],
  ["no dead out_len/OUT_CAP", !fresh.includes("out_len") && !fresh.includes("OUT_CAP")],
  ["no texture machinery (unreferenced bridges gated)", !fresh.includes("uTex") && !fresh.includes("uCrack") && !fresh.includes("texture2D") && !fresh.includes("vUv")],
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
