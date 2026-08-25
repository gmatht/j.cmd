import { readFileSync } from "fs";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs } from "./src/estree.js";
const lib = await getOtranspilerl();
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const out = lib.compile(src);
const estree = typeof out === "string" ? JSON.parse(out) : out;
const program = estree.estree || estree;
const bodyJs = await estreeToJs({ type: "Program", body: program.body || [] }, { repl: false, precompiledHead: true });
// find the render_frame function body — check the depthmask/blocks writes
const i = bodyJs.indexOf("function render_frame");
console.log("render_frame at", i);
const seg = bodyJs.slice(i, i + 3000);
// show the depthmask / blocks / overlay writes
const lines = seg.split("\n");
const relevant = lines.filter((l) => /depthmask|blocks|uOverlay|clear|blk_p|bg_p|try_draw/.test(l));
console.log(relevant.slice(0, 30).join("\n"));
