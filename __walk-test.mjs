import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { env } from "./src/env.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { estreeToJs } from "./src/estree.js";
import { getOtranspilerl } from "./src/otranspilerl.js";

const a1 = JSON.parse(readFileSync("/tmp/u2.a1.json", "utf8"));
const lib = await getOtranspilerl();
const estree = JSON.parse(lib.render(JSON.stringify(a1), "js"));
const js = await estreeToJs(estree);
let out = "";
const stdout = { write: (s) => { out += String(s); } };
const rt = createSh2Runtime({ fs, env, shellExec: async () => 0, stdout, stderr: stdout, args: [], argv0: "sh" });
const proc = { stdout, stderr: stdout, pid: 1, argv: ["sh"], env, cwd: () => fs.cwd, chdir() {}, exit(c) { const e = new Error("x"+c); e.exitCode=c||0; throw e; } };
await new Function("fs","env","process","sh2", `return (async () => { ${js} })();`)(fs, env, proc, rt.sh2);

// shell array + addr-style handle (what `a=(10 20 30); sum_first "$(addr a)" 3` does)
rt.sh2.setArray("a", ["10", "20", "30"]);
const h = rt.sh2.memAddrOf("a");
console.log("handle:", JSON.stringify(h));
console.log("sum_first(a,3) →", await rt.sh2.fnCall("sum_first", [h, "3"]), "(want 60)");
// fill: *p = i*10 — writes back into the shell array
await rt.sh2.fnCall("fill", [h, "3"]);
console.log("after fill:     a =", JSON.stringify(rt.sh2.vars.a), "(want [0,10,20])");
// fill_post: *p++ = i — classic idiom, also writes + advances
await rt.sh2.fnCall("fill_post", [h, "3"]);
console.log("after fill_post: a =", JSON.stringify(rt.sh2.vars.a), "(want [0,1,2])");
// scalar var (n=1 walk)
rt.sh2.vars.x = "42";
console.log("sum_first(x,1) →", await rt.sh2.fnCall("sum_first", [rt.sh2.memAddrOf("x"), "1"]), "(want 42)");
// compound deref: bump via *p += 1
await rt.sh2.fnCall("fill", [h, "3"]);
