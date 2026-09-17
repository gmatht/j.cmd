import { readFileSync } from "node:fs";
import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const fs = readFileSync("www/examples/mimecroft-frag.sh", "utf8");
const glsl = lib.glsl(fs);
console.log(glsl);
