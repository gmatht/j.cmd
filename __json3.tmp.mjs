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
for (const needle of ["fnCall", "callDirect", "split", "filter"]) {
  const i = s.indexOf(needle);
  console.log(needle, "→", i >= 0 ? s.slice(Math.max(0, i - 120), i + 260) : "NOT IN JSON");
  console.log("---");
}
