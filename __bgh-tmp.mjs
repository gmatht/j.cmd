import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
await fs.write("/www/examples/textures/texture-dirt.sh", readFileSync("www/examples/textures/texture-dirt.sh", "utf8"));

const src = `echo before
bash /www/examples/textures/texture-dirt.sh --tsv --size 32 --seed 20240812 > /tmp/tex-dirt.tsv &
echo after-bg
`;
const { js } = await bashToJS(fs, src);
console.log("thread heuristic fired:", /exec\("bash"/.test(js) && js.includes("sh2.background"));
const rt = createSh2Runtime({ fs, env: {}, shellExec: async () => ({ out: "", err: "", code: 0 }), stdout: { write: () => {} }, stderr: { write: () => {} }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
let out = "";
const t0 = Date.now();
try { await Promise.race([fn([], fs, {}, { write: (s) => { out += s; } }, { write: () => {} }, async () => ({ out: "", err: "", code: 0 }), rt.sh2), new Promise((_, rej) => setTimeout(() => rej(new Error("stop")), 60000))]); }
catch (e) { console.log("RUN ERR:", e.message); }
const submitMs = Date.now() - t0;
console.log("script returned in", submitMs, "ms —", JSON.stringify(out.trim()), "(should be 'before after-bg' fast)");
// poll for the /tmp result
let waited = 0;
let result = "";
while (waited < 60000) {
  try { result = await fs.read("/tmp/tex-dirt.tsv"); if (result && result.includes("#texture")) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
  waited += 100;
}
console.log("result ready after", waited, "ms; starts #texture:", result.startsWith("#texture"), "bytes:", result.length);
const host = execFileSync("bash", ["www/examples/textures/texture-dirt.sh", "--tsv", "--size", "32", "--seed", "20240812"], { encoding: "utf8" });
const norm = (s) => s.split("\n").filter(l => l.trim() && !l.startsWith("#texture") && !l.startsWith("texture")).map(l => l.trim()).join("\n");
console.log("matches host:", norm(result) === norm(host));
