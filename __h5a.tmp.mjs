import { readFileSync, readdirSync } from "fs";
import { fs } from "./src/fs/index.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs } from "./src/estree.js";
const lib = await getOtranspilerl();
const files = ["www/bin/mimecroft.sh",
  ...readdirSync("www/examples/textures").filter(n => n.endsWith(".sh")).map(n => "www/examples/textures/" + n),
  ...readdirSync("/home/llm/sh2loop/sh2perl/examples").filter(n => n.endsWith(".sh")).map(n => "/home/llm/sh2loop/sh2perl/examples/" + n)];
let mism = 0, checked = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    const oldJs = await estreeToJs(JSON.parse(lib.transpile(src, "sh", "js")), { repl: false });
    const c = JSON.parse(lib.compile(src));
    const newJs = await estreeToJs(c.estree, { repl: false, precompiledHead: true });
    checked++;
    if (oldJs !== newJs) { mism++; console.log("MISMATCH:", f.split("/").pop()); }
  } catch (e) { mism++; console.log("ERR:", f.split("/").pop(), e.message.slice(0, 50)); }
}
console.log(`checked ${checked} files, ${mism} mismatches`);
