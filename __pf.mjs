import { readFileSync } from "fs";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs } from "./src/estree.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const lib = await getOtranspilerl();
const out = lib.compile(src);
const estree = typeof out === "string" ? JSON.parse(out) : out;
const program = estree.estree || estree;
const bodyJs = await estreeToJs({ type: "Program", body: program.body || [] }, { repl: false, precompiledHead: true });
const i = bodyJs.indexOf('sh2.functions.set("preview_frame"');
const seg = bodyJs.slice(i, i + 3000);
// print the case section
const c = seg.indexOf("$sh_case = sm_ai_keys");
console.log(seg.slice(c, c + 900));
