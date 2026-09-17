// ─── otranspilerl analyze() smoke ────────────────────────────────
// Guards the otranspilerl_analyze C-ABI export + JS binding (the Rust
// core static-analysis facts for annotation consumers): the export
// exists, the mode flag reaches Rust, the JSON parses against the
// documented schema, a known program yields its scope/var, and garbage
// raises instead of trapping the wasm.
import { getOtranspilerl } from "../src/otranspilerl.js";

let failures = 0;
function ok(cond, what, detail) {
  if (cond) { console.log("  ok   " + what); return; }
  failures++;
  console.log("  FAIL " + what + (detail ? "\n       " + detail : ""));
}

console.log("otranspilerl analyze() smoke");
const lib = await getOtranspilerl();
ok(typeof lib.analyze === "function", "lib.analyze binding exists");
const a1 = lib.shir("for i in 1 2 3; do echo $i; done", "sh");
for (const mode of ["bash", "python"]) {
  let out = null;
  try { out = JSON.parse(lib.analyze(a1, mode)); } catch (e) { ok(false, mode + ": output parses as JSON", String(e.message).slice(0, 160)); continue; }
  ok(out.mode === mode, mode + ": mode flag reaches Rust and echoes back", JSON.stringify(out).slice(0, 120));
  ok(Array.isArray(out.scopes) && out.scopes.length >= 1, mode + ": scopes[] present");
  const top = out.scopes[0] || {};
  ok(top.name === "<top>" && top.vars && top.vars.i, mode + ": top scope carries the loop counter i", JSON.stringify(top.vars));
}
let threw = false;
try { lib.analyze("not json", "python"); } catch { threw = true; }
ok(threw, "malformed A1 raises instead of trapping");
console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));
if (failures) process.exit(1);
