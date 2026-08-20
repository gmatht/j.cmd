// ─── __shader-test.mjs — bash→GLSL ES 1.00 shader gate ───────────
// The game's shaders are AUTHORED IN BASH and compiled in-browser via
// sh2glsl (otranspilerl_glslv for the vertex, otranspilerl_glsl for
// the fragment). The headless NullGL device never type-checks GLSL —
// the browser's ANGLE is the only runtime judge, and the game falls
// back to hand-written shaders when the generated ones fail. This gate
// does the real compile check:
//
//   1. generate the vertex shader from www/examples/mimecroft-vertex.sh
//      and the fragment from the game's INLINE program (assembled from
//      emit_fragment_shader) through the otranspilerl wasm;
//   2. assert the canonical www/examples/mimecroft-frag.sh code section is
//      byte-identical to the game's inline program (drift = FAIL);
//   3. validate vertex + fragment + canonical as GLSL ES 1.00 with
//      glslangValidator (#version 100 prepended);
//   4. assert the committed reference .glsl files match the generated
//      output (stale reference = FAIL).
//
// glslangValidator (apt: glslang-tools) is the ground truth — glslc
// cannot judge ES 1.00 (its SPIR-V output requires ≥310 ES). When the
// validator is absent the test warns and skips only step 3.
//
//   node __shader-test.mjs   → "ALL SHADER CHECKS PASSED"
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getOtranspilerl } from "./src/otranspilerl.js";

let fails = 0;
const ok = (msg) => console.log("  ok  " + msg);
const bad = (msg) => { console.log("  FAIL " + msg); fails++; };

const lib = await getOtranspilerl();
const VALIDATOR = "glslangValidator";
let validatorOk = true;
try { execFileSync(VALIDATOR, ["--version"], { stdio: "ignore" }); }
catch { validatorOk = false; console.log("  note: glslangValidator not found (apt install glslang-tools) — skipping the ES 1.00 compile check"); }

const es100 = (glsl) => "#version 100\n" + glsl;

// ─── 1) pipeline: generate both shaders from bash ────────────────
console.log("bash → GLSL generation…");
let vs, fragInline;
try {
  vs = lib.glslv(readFileSync("www/examples/mimecroft-vertex.sh", "utf8"));
  ok(`vertex: www/examples/mimecroft-vertex.sh → ${vs.length} bytes`);
} catch (e) { bad("vertex generation: " + e.message); }
try {
  // the game's ACTUAL fragment program: emit_fragment_shader writes
  // these echo lines to /tmp/mimecroft-frag.sh at startup
  const src = readFileSync("www/bin/mimecroft.sh", "utf8");
  const m = src.match(/emit_fragment_shader\(\) \{(.*?)\n\}/s);
  const lines = [];
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^\s*echo '((?:[^'\\]|\\.)*)'\s*(?:>>|>)/);
    if (mm) { lines.push(mm[1]); continue; }
    // the display-size CRT centring is emitted DOUBLE-quoted so the
    // runtime substitutes the canvas half-width/height:
    //   echo "vx=\$((fx - $disp_hw))"
    // Extract it with the DEFAULT 800x600 halves (the canonical is the
    // default-size program) — un-escape \$ and substitute $disp_hw/hh.
    const md = line.match(/^\s*echo "((?:[^"\\]|\\.)*)"\s*(?:>>|>)/);
    if (md) {
      lines.push(md[1].replace(/\\\$/g, "$").replace(/\$disp_hw/g, "400").replace(/\$disp_hh/g, "300"));
    }
  }
  const program = lines.join("\n") + "\n";
  fragInline = lib.glsl(program);
  ok(`fragment: game inline program (${lines.length} lines) → ${fragInline.length} bytes`);
} catch (e) { bad("fragment generation: " + e.message); }

// ─── 2) canonical www/examples/mimecroft-frag.sh must BE the game's program
console.log("canonical ↔ game drift…");
if (fragInline) {
  const fragSrc = readFileSync("www/examples/mimecroft-frag.sh", "utf8");
  const code = fragSrc.split("\n").filter((l) => !l.trim().startsWith("#") && l.trim() !== "").join("\n") + "\n";
  if (code === readFileSync("www/examples/mimecroft-vertex.sh", "utf8").split("\n")[0]) {
    bad("canonical www/examples/mimecroft-frag.sh is empty of code");
  } else if (lib.glsl(code) === fragInline) {
    ok("www/examples/mimecroft-frag.sh code section == the game's inline program");
  } else {
    bad("www/examples/mimecroft-frag.sh has DRIFTED from emit_fragment_shader — re-sync it (copy the inline program into the code section)");
  }
}

// ─── 3) ES 1.00 compile check (the real gate) ────────────────────
console.log("GLSL ES 1.00 validation (glslangValidator)…");
const validate = (stage, name, glsl) => {
  if (!validatorOk || !glsl) return;
  const tmp = "/tmp/__shader-test." + (stage === "vert" ? "v" : "f") + ".glsl";
  writeFileSync(tmp, es100(glsl));
  try {
    execFileSync(VALIDATOR, ["-S", stage, tmp], { stdio: "pipe" });
    ok(`${name}: ES 1.00 valid`);
  } catch (e) {
    bad(`${name}: ES 1.00 INVALID\n${String(e.stderr).split("\n").filter((l) => l.includes("ERROR")).slice(0, 8).join("\n")}`);
  }
};
validate("vert", "vertex (from bash)", vs);
validate("frag", "fragment inline (from bash)", fragInline);
if (fragInline) {
  const fragSrc = readFileSync("www/examples/mimecroft-frag.sh", "utf8");
  validate("frag", "canonical www/examples/mimecroft-frag.sh", lib.glsl(
    fragSrc.split("\n").filter((l) => !l.trim().startsWith("#") && l.trim() !== "").join("\n")));
}

// ─── 4) committed reference .glsl must match the generated output ─
console.log("reference .glsl identity…");
for (const [refFile, genGlsl] of [
  ["www/examples/mimecroft-vertex.glsl", vs],
  ["www/examples/mimecroft-frag.glsl", fragInline],
]) {
  if (!genGlsl) continue;
  const ref = readFileSync(refFile, "utf8");
  if (ref === genGlsl) ok(`${refFile} == generated output`);
  else bad(`${refFile} is STALE (${ref.length} vs ${genGlsl.length} bytes) — regenerate it`);
}

console.log(fails ? `SHADER GATE FAILED (${fails})` : "ALL SHADER CHECKS PASSED");
process.exit(fails ? 1 : 0);
