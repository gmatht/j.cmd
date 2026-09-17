import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
for (const src of ["x=$(seq 1 3)", "x=$(wc -l /home/hello.txt)", 'echo "$x" | grep -q ell', "test -f /home/hello.txt && cat /home/hello.txt"]) {
  console.log("=== " + src + " ===");
  const a1 = lib.shir(src);
  // pretty-print a compact form
  const j = JSON.parse(a1);
  console.log(JSON.stringify(j, null, 1).slice(0, 1400));
  console.log();
}
