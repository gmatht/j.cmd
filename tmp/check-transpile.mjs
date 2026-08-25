import { readFileSync } from "fs";
import { getOtranspilerl } from "../src/otranspilerl.js";
const lib = await getOtranspilerl();
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const t0 = Date.now();
const js = lib.transpile(src, "sh", "js");
console.log("MIMEcroft.sh transpile OK:", js.length, "chars in", Date.now() - t0, "ms");
const shir = lib.shir(src);
console.log("shir OK:", shir.length, "chars");
