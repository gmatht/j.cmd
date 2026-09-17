import { getOtranspilerl } from "./src/otranspilerl.js";
import { fs } from "./src/fs/index.js";
import { pyExec } from "./src/py.js";
const lib = await getOtranspilerl();
const cases = [
  ["x=$(seq 1 3); echo \"$x\"", "1\n2\n3\n"],
  ["x=$(wc -l /home/hello.txt); echo \"$x\"", "1\n"],
  ['echo hello | grep -q ell; echo $?', "0\n"],
  ['echo hello | grep -q zzz; echo $?', "1\n"],
  ["test -f /home/hello.txt && cat /home/hello.txt", "Hello from RamFS! Contents lost on restart.\n"],
  ["test -f /nope.txt && cat /nope.txt; echo done", "done\n"],
];
for (const [src, want] of cases) {
  const a1 = lib.shir(src);
  const py = lib.render(a1, "python");
  let out = "";
  let code = 0;
  try {
    code = await pyExec(py, { stdout: (s) => { out += s; }, stderr: (s) => { out += "[err] " + s; } });
  } catch (e) { out += "[throw] " + e.message; }
  const ok = out === want;
  console.log((ok ? "PASS" : "FAIL") + "  " + src + "  => " + JSON.stringify(out) + (ok ? "" : " want " + JSON.stringify(want)) + " (code " + code + ")");
}
