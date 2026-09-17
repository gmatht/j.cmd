import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const cases = [
  "x=$(seq 1 3); echo \"$x\"",
  "x=$(seq 3); echo \"$x\"",
  "x=$(seq 1 2 9); echo \"$x\"",
  "x=$(wc -l /home/hello.txt); echo \"$x\"",
  'x=hello; echo "$x" | grep -q ell; echo $?',
  'x=hello; echo "$x" | grep -q zzz; echo $?',
  'x=hello; echo "$x" | grep -q -v zzz; echo $?',
  "test -f /home/hello.txt && cat /home/hello.txt",
  "test -f /nope.txt && cat /nope.txt; echo done",
];
for (const src of cases) {
  console.log("=== " + src + " ===");
  const a1 = lib.shir(src);
  const py = lib.render(a1, "python");
  // show only the interesting lines
  console.log(py.split("\n").filter((l) => /seq|wc|grep|isfile|__sh_rc|range|readlines|check_output|__sh_exec|__sh_run_status/.test(l)).join("\n") || "(no interesting lines)");
  console.log();
}
