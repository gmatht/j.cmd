import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const a1 = lib.shir("x=$(seq 1 3); echo \"$x\"");
const py = lib.render(a1, "python");
console.log("=== rendered python ===");
console.log(py);
