import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
const src = `g() { x=$(date); }
f() { g; echo hi; }
f
`;
const program = JSON.parse(lib.transpile(src, "sh", "js"));
const s = JSON.stringify(program);
// the fnCall node: find "fnCall" or the CallExpression with callee "fnCall"
const i = s.indexOf("fnCall");
console.log("fnCall node:", s.slice(Math.max(0, i - 200), i + 400));
