// ─── __glsl-capable-test.mjs — GPU-capability detection gate ────
// The sh→GLSL backend renders unsupported constructs as markers with a
// footer count — the "capable" signal the docs tell you to check by
// hand. src/shglsl-capable.js makes it automatic and closes the three
// gaps where the footer lies (recursion, byte output in a vertex
// program, no output at all). This gate asserts the detector's verdicts
// on the reference shaders and on each gap:
//
//   1. mimecroft-frag.sh  → fragment CAPABLE, vertex NOT (byte output)
//   2. mimecroft-vertex.sh → vertex CAPABLE, fragment NOT (vp_* only)
//   3. unsupported constructs → both NOT, with the exact breakdown
//   4. recursion → both NOT (the footer says 0 — the detector catches it)
//   5. mutual recursion → both NOT, cycle reported
//   6. putb-only fragment → fragment CAPABLE, vertex NOT
//   7. i64/arith-parse markers → counted in the breakdown
//   8. empty program → both NOT (no output warnings)
//
//   node __glsl-capable-test.mjs   → "ALL GLSL-CAPABLE CHECKS PASSED"
import { readFileSync } from "node:fs";
import { glslCapable } from "./src/shglsl-capable.js";

let fails = 0;
const ok = (msg) => console.log("  ok  " + msg);
const bad = (msg) => { console.log("  FAIL " + msg); fails++; };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

const frag = readFileSync("www/examples/mimecroft-frag.sh", "utf8");
const vert = readFileSync("www/examples/mimecroft-vertex.sh", "utf8");

console.log("== reference shaders ==");
{
  const r = await glslCapable(frag);
  check(r.fragment.capable, "mimecroft-frag.sh: fragment CAPABLE");
  check(!r.vertex.capable, "mimecroft-frag.sh: vertex NOT CAPABLE (byte output)");
  check(
    r.vertex.warnings.some((w) => w.includes("byte output")),
    "mimecroft-frag.sh: vertex warning names the byte output"
  );
}
{
  const r = await glslCapable(vert);
  check(r.vertex.capable, "mimecroft-vertex.sh: vertex CAPABLE");
  check(!r.fragment.capable, "mimecroft-vertex.sh: fragment NOT CAPABLE (vp_* only)");
  check(
    r.fragment.warnings.some((w) => w.includes("vp_*")),
    "mimecroft-vertex.sh: fragment warning names the vp_* outputs"
  );
}

console.log("== unsupported constructs ==");
{
  const src = "x=5\necho hello\nls -la\ncat /etc/passwd\necho hi | grep foo\n( subshell )\nsleep 1 &\nprintf \"%s\" $x";
  const r = await glslCapable(src);
  check(!r.fragment.capable && !r.vertex.capable, "unsupported program: both stages NOT CAPABLE");
  check(r.fragment.total === 6, `unsupported program: footer total 6 (got ${r.fragment.total})`);
  const what = r.fragment.unsupported.map((u) => u.what);
  for (const w of ["exec ls", "exec cat", "pipeline", "subshell", "background", "printf non-literal format"]) {
    check(what.includes(w), `unsupported program: breakdown names "${w}"`);
  }
}

console.log("== recursion (the footer's blind spot) ==");
{
  const src = "f() {\n  echo hi\n  f\n}\nf";
  const r = await glslCapable(src);
  check(r.fragment.total === 0, "recursion: footer says 0 unsupported (the gap)");
  check(r.recursion.length > 0, `recursion: cycle detected (${JSON.stringify(r.recursion)})`);
  check(!r.fragment.capable && !r.vertex.capable, "recursion: both stages NOT CAPABLE");
}
{
  const src = "a() {\n  b\n}\nb() {\n  a\n}\na";
  const r = await glslCapable(src);
  check(r.recursion.length === 3, `mutual recursion: 3-member cycle (${JSON.stringify(r.recursion)})`);
  check(!r.fragment.capable, "mutual recursion: fragment NOT CAPABLE");
}

console.log("== stage contracts ==");
{
  const r = await glslCapable("putb 255\nputb 0\nputb 128\nputb 64");
  check(r.fragment.capable, "putb-only program: fragment CAPABLE");
  check(!r.vertex.capable, "putb-only program: vertex NOT CAPABLE (out_buf undeclared)");
}
{
  const r = await glslCapable("x=$((1+2))\necho $x");
  check(!r.fragment.capable, "unquoted $x echo: fragment NOT CAPABLE (call split)");
  check(
    r.fragment.unsupported.some((u) => u.what === "call split"),
    "unquoted $x echo: breakdown names 'call split'"
  );
}
{
  const r = await glslCapable("x=$((99999999999999999999))\necho $x");
  check(r.fragment.total === 2, `i64/arith-parse: total 2 (got ${r.fragment.total})`);
  check(
    r.fragment.unsupported.some((u) => u.what === "arith parse"),
    "i64/arith-parse: breakdown names 'arith parse'"
  );
}
{
  const r = await glslCapable("");
  check(!r.fragment.capable && !r.vertex.capable, "empty program: both NOT CAPABLE");
  check(
    r.fragment.warnings.some((w) => w.includes("no output")),
    "empty program: fragment warning names the missing output"
  );
}

console.log(fails === 0 ? "\nALL GLSL-CAPABLE CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
