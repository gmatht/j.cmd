import { readFileSync } from "node:fs";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs } from "./src/estree.js";
const a1 = JSON.parse(readFileSync("/tmp/u2.a1.json", "utf8"));
const lib = await getOtranspilerl();
const estree = JSON.parse(lib.render(JSON.stringify(a1), "js"));
console.log(await estreeToJs(estree));
