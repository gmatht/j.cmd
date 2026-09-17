import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
for (const src of ["x=$(seq 1 3); echo \"$x\"", "x=$(wc -l /tmp/rtfile.txt); echo \"$x\"", 'echo hello | grep -q ell; echo $?', "test -f /tmp/rtfile.txt && cat /tmp/rtfile.txt"]) {
  console.log("=== " + src + " ===");
  const a1 = lib.shir(src);
  console.log(lib.render(a1, "sh"));
  console.log();
}
