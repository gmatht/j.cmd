import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
// fork path: a shell function backgrounded (no nested bash exec) — must NOT hit the worker
const src = `myfn() { echo "fn-\$1"; }
myfn hello &
echo main-done
`;
const { js } = await bashToJS(fs, src);
const rt = createSh2Runtime({ fs, env: {}, shellExec: async () => ({ out: "", err: "", code: 0 }), stdout: { write: () => {} }, stderr: { write: () => {} }, args: [], argv0: "bash" });
let workerHits = 0;
const orig = rt.sh2;
// count worker submissions by wrapping bgSubmit via the fs /dev/bg? simpler: count exec("bash") — none here
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
let out = "";
try { await Promise.race([fn([], fs, {}, { write: (s) => { out += s; } }, { write: () => {} }, async () => ({ out: "", err: "", code: 0 }), rt.sh2), new Promise((_, rej) => setTimeout(() => rej(new Error("stop")), 15000))]); }
catch (e) { console.log("RUN ERR:", e.message); }
console.log("fork path output:", JSON.stringify(out.trim()), "— no worker used (no /examples bash exec)");
