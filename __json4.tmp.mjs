import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const src = `g() { x=$1; }
f() { g 42; echo hi; }
f
`;
const program = JSON.parse(lib.transpile(src, "sh", "js"));
const s = JSON.stringify(program);
const i = s.indexOf("callDirect");
console.log(s.slice(Math.max(0, i - 300), i + 700));
