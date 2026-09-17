import { getOtranspilerl } from "./src/otranspilerl.js";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const lib = await getOtranspilerl();
const cases = [
  ["x=$(seq 1 3); echo \"$x\"", "1\n2\n3\n"],
  ["x=$(seq 1 2 9); echo \"$x\"", "1\n3\n5\n7\n9\n"],
  ["x=$(wc -l /tmp/rtfile.txt); echo \"$x\"", "3\n"],
  ['echo hello | grep -q ell; echo $?', "0\n"],
  ['echo hello | grep -q zzz; echo $?', "1\n"],
  ['echo hello | grep -q -v zzz; echo $?', "0\n"],
  ["test -f /tmp/rtfile.txt && cat /tmp/rtfile.txt", "line one\nline two\nline three\n"],
  ["test -f /tmp/nope-xyz.txt && cat /tmp/nope-xyz.txt; echo done", "done\n"],
];
let fails = 0;
for (const [src, want] of cases) {
  const a1 = lib.shir(src);
  const sh = lib.render(a1, "sh");
  writeFileSync("/tmp/rt.sh", sh);
  let out = "";
  try { out = execSync("dash /tmp/rt.sh", { encoding: "utf8" }); } catch (e) { out = "[err] " + (e.stderr || e.message); }
  const ok = out === want;
  if (!ok) fails++;
  console.log((ok ? "PASS" : "FAIL") + "  " + src + "  => " + JSON.stringify(out) + (ok ? "" : " want " + JSON.stringify(want)));
}
console.log(fails === 0 ? "\n✓ all sh lifts produce identical output" : `\n✗ ${fails} failed`);
