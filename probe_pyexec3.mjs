import { getOtranspilerl } from "./src/otranspilerl.js";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const lib = await getOtranspilerl();
const cases = [
  ["x=$(wc -l /tmp/rtfile.txt); echo \"$x\"", "3\n"],
  ["test -f /tmp/rtfile.txt && cat /tmp/rtfile.txt", "line one\nline two\nline three\n"],
  ["test -f /tmp/nope-xyz.txt && cat /tmp/nope-xyz.txt; echo done", "done\n"],
];
let fails = 0;
for (const [src, want] of cases) {
  const a1 = lib.shir(src);
  const py = lib.render(a1, "python");
  writeFileSync("/tmp/rt.py", py);
  let out = "";
  try { out = execSync("python3 /tmp/rt.py", { encoding: "utf8" }); } catch (e) { out = "[err] " + (e.stderr || e.message); }
  const ok = out === want;
  if (!ok) fails++;
  console.log((ok ? "PASS" : "FAIL") + "  " + src + "  => " + JSON.stringify(out) + (ok ? "" : " want " + JSON.stringify(want)));
}
console.log(fails === 0 ? "\n✓ all python lifts produce identical output" : `\n✗ ${fails} failed`);
