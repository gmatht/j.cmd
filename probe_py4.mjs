import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const cases = [
  'echo hello | grep -q ell; echo $?',
  'echo hello | grep -q zzz; echo $?',
  'x=hello; echo "$x" | grep -q ell; echo "$x"',
  'x=hello; echo "$x" | grep -q -v zzz; echo $?',
];
for (const src of cases) {
  console.log("=== " + src + " ===");
  const a1 = lib.shir(src);
  console.log(lib.render(a1, "python").split("\n").filter((l) => /grep|__sh_rc|print|hello|in /.test(l)).join("\n"));
  console.log();
}
