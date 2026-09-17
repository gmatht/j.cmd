import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const src = `g() { x=$(date); }
f() { g; echo hi; }
f
`;
const a1 = JSON.parse(lib.shir(src));
const program = JSON.parse(lib.transpile(src, "sh", "js"));
// find the f body: the call to g
const s = JSON.stringify(program, null, 1);
const i = s.indexOf('"g"');
console.log("estree JSON around the g call:");
console.log(s.slice(Math.max(0, i - 400), i + 500));
