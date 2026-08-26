// ─── __glsl-auto-test.mjs — the automatic shader pipeline gate ──
// The vision: replace the explicit `sh2glsl` step with a plain eval —
// the runtime runs the bash normally and src/shglsl-auto.js decides
// whether to transparently offload it to the GPU. The four questions:
//
//   (a) static — pre-compilable & reusable (no eval/source/.)
//   (b) shader — compiles to a WORKING shader in ≥1 stage
//   (c) kind   — fragment | vertex | null (the output model decides)
//   (d) worth  — invocation-parameterized (reads the stage's bridges)
//                AND the invocation count is large enough
//
// This gate asserts the verdicts on the reference shaders and on each
// of the four questions, plus the translation cache (a).
//
//   node __glsl-auto-test.mjs   → "ALL GLSL-AUTO CHECKS PASSED"
import { readFileSync } from "node:fs";
import { analyzeShader, shouldOffload, getShaderTranslation, shaderCache } from "./src/shglsl-auto.js";

let fails = 0;
const ok = (msg) => console.log("  ok  " + msg);
const bad = (msg) => { console.log("  FAIL " + msg); fails++; };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

const frag = readFileSync("www/examples/mimecroft-frag.sh", "utf8");
const vert = readFileSync("www/examples/mimecroft-vertex.sh", "utf8");

console.log("== (a) static / pre-compilable ==");
{
  const r = await analyzeShader("x=3");
  check(r.static === true, "x=3: static (pre-compilable)");
  check(r.selfModifying.length === 0, "x=3: no self-modification");
}
{
  const r = await analyzeShader("eval \"putb 255\"");
  check(r.static === false, "eval: NOT static (self-modifying)");
  check(r.selfModifying.includes("eval"), "eval: selfModifying names 'eval'");
}
{
  const r = await analyzeShader("source /etc/rc");
  check(r.static === false, "source: NOT static");
}

console.log("== (b) is it a shader ==");
{
  const r = await analyzeShader("x=3");
  check(r.shader === false, "x=3: not a shader (no output)");
}
{
  const r = await analyzeShader("putb 255\nputb 0\nputb 128\nputb 64");
  check(r.shader === true, "putb-only: IS a shader");
}
{
  const r = await analyzeShader("ls -la");
  check(r.shader === false, "ls: not a shader (unsupported)");
}

console.log("== (c) what sort of shader ==");
{
  const r = await analyzeShader(frag);
  check(r.kind === "fragment", "mimecroft-frag.sh: kind=fragment");
}
{
  const r = await analyzeShader(vert);
  check(r.kind === "vertex", "mimecroft-vertex.sh: kind=vertex");
}
{
  const r = await analyzeShader("putb 255");
  check(r.kind === "fragment", "putb: kind=fragment (byte output is fragment-only)");
}
{
  const r = await analyzeShader("vp_x=5\nvp_y=5\nvp_z=5\nvp_w=1");
  check(r.kind === "vertex", "vp_*: kind=vertex (gl_Position is vertex-only)");
}

console.log("== (d) worth offloading ==");
{
  const r = await analyzeShader("x=3");
  check(r.worth === false, "x=3: not worth (the user's example)");
}
{
  const r = await analyzeShader("echo 3");
  check(r.worth === false, "echo 3: not worth (no bridge reads — GPU would compute the same bytes N times)");
  check(r.readsFrag === false, "echo 3: readsFrag=false");
}
{
  const r = await analyzeShader("putb $((frag_x % 256))\nputb $((frag_y % 256))");
  check(r.worth === true, "per-pixel gradient: worth (reads frag_x)");
  check(r.readsFrag === true, "per-pixel gradient: readsFrag=true");
}
{
  const r = await analyzeShader(frag);
  check(r.worth === true, "mimecroft-frag.sh: worth");
  check(r.readsFrag === true && r.ops >= 50, "mimecroft-frag.sh: reads bridges, heavy (ops=" + r.ops + ")");
}
{
  const r = await analyzeShader(vert);
  check(r.worth === true, "mimecroft-vertex.sh: worth");
  check(r.readsVert === true, "mimecroft-vertex.sh: readsVert=true");
}
{
  // tiny canvas — the fixed GPU overhead dominates
  const r = await analyzeShader("putb $((frag_x % 256))", { view: 8, pixels: 64 });
  check(r.worth === false, "tiny canvas (64 px): not worth");
}

console.log("== the eval-fallback decision ==");
{
  const d = await shouldOffload("x=3");
  check(d.offload === false, "x=3: eval (no offload)");
}
{
  const d = await shouldOffload("putb $((frag_x % 256))");
  check(d.offload === true, "gradient: offload to GPU");
}
{
  const d = await shouldOffload(frag);
  check(d.offload === true, "mimecroft-frag.sh: offload to GPU");
}

console.log("== (a) the translation cache ==");
{
  shaderCache().clear();
  const t1 = await getShaderTranslation(frag);
  const t2 = await getShaderTranslation(frag);
  check(t1.hit === false, "cache: first compile is a miss");
  check(t2.hit === true, "cache: re-eval reuses the translation (hit)");
  check(t1.frag === t2.frag && t1.vert === t2.vert, "cache: identical GLSL on reuse");
  check(shaderCache().size === 1, "cache: one entry for one source");
}

console.log("== partial lift (the factor.sh case) ==");
// The original factor.sh is NOT liftable (argv, exit, regex !, array
// append, [ ] tests) — but the trial-division core IS, once the
// parallel dimension is made explicit: one pixel per number (batch) or
// one pixel per divisor candidate (sieve). Both must be detected as
// shaders, worth it, with zero unsupported constructs.
{
  const original = readFileSync("www/examples/factor.sh", "utf8");
  const r = await analyzeShader(original);
  check(r.shader === false, "factor.sh as-is: not a shader");
  check(r.worth === false, "factor.sh as-is: not worth (no bridge reads)");
  const what = r.report.fragment.unsupported.map((u) => u.what);
  for (const w of ["exec exit", "array append", "call param"]) {
    check(what.includes(w), `factor.sh as-is: breakdown names "${w}"`);
  }
}
{
  // batch lift: the SAME trial-division loop, per-pixel, n from a texture
  const batch = `n=$((tex_r * 65536 + tex_g * 256 + tex_b))
d=2
while [ $((d * d)) -le "$n" ]; do
    while [ $((n % d)) -eq 0 ]; do
        n=$((n / d))
    done
    d=$((d + 1))
done
putb $((n % 256))`;
  const r = await analyzeShader(batch);
  check(r.shader === true && r.kind === "fragment", "batch lift: IS a shader (fragment)");
  check(r.worth === true, "batch lift: worth (reads the tex bridge)");
  check(r.report.fragment.total === 0, "batch lift: 0 unsupported (the loop compiles)");
  check(r.loops === 2, `batch lift: the trial-division loops survive (loops=${r.loops})`);
}
{
  // divisor-sieve lift: one pixel per divisor candidate (d = frag_x)
  const sieve = `n=$((tex_r * 65536 + tex_g * 256 + tex_b))
d=$((frag_x + 1))
if [ $((n % d)) -eq 0 ]; then
    putb 255
else
    putb 0
fi`;
  const r = await analyzeShader(sieve);
  check(r.shader === true && r.kind === "fragment", "sieve lift: IS a shader (fragment)");
  check(r.worth === true, "sieve lift: worth (reads frag_x)");
  check(r.report.fragment.total === 0, "sieve lift: 0 unsupported (the % modulo emulates)");
  check(r.readsFrag === true, "sieve lift: readsFrag=true (d = frag_x)");
}

console.log(fails === 0 ? "\nALL GLSL-AUTO CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
