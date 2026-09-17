import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
for (const src of ['x=hello; echo "$x" | grep -q ell; echo $?', "test -f /home/hello.txt && cat /home/hello.txt"]) {
  console.log("=== " + src + " ===");
  const a1 = lib.shir(src);
  console.log(lib.render(a1, "python"));
  console.log();
}
