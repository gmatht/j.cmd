import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0", "MIMES_ON=1");
src = src.replace("*headless*) sound=$((0)); headless=$((0)) ;;", "*headless*) sound=$((0)); headless=$((1)) ;;");
const { js } = await bashToJS(fs, src);
// find the sync-redirect throw in the runtime source and patch it to log
let rtSrc = readFileSync("src/sh2runtime.js", "utf8");
rtSrc = rtSrc.replace(
  'throw new Error("redirection needs the async redirect bridge; try `bash` for this construct");',
  'console.error("REDIRECT-FAIL: fd=" + fd + " target=" + JSON.stringify(target) + " redirects=" + JSON.stringify(redirects)); throw new Error("redirection needs the async redirect bridge");'
);
// patch the runtime module load to use the modified source — simpler: monkeypatch at runtime via a wrapper
const out = { write: () => {} };
const rt = createSh2Runtime({ fs, env: {}, shellExec: async () => ({out:'',err:'',code:0}), stdout: out, stderr: { write: (s) => console.error("ERR:", s) }, args: [], argv0: "bash" });
// can't easily patch the closure; instead wrap the game JS: replace the sync redirect call form
const KEYS = ["w,", "q,"];
let keyFrame = 0, sleepCount = 0;
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let o = "";
  if (cmd === "echo") o = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { o = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else { try { o = await fs.read(p); } catch { o = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 20) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { o = ""; }
  else if (cmd === "true") {}
  else o = `${cmd}: command not found\n`;
  return { out: o, err: "", code: 0 };
};
// find the emitted form that passes redirects to a builtin: search for 'redirects'
const red = js.match(/[^;\n]{0,120}redirects[^;\n]{0,120}/g);
console.log("redirects-array emissions:", red ? red.slice(0, 3) : "NONE");
// run with a global error handler that prints the stack
process.on("uncaughtException", (e) => { console.log("UNCAUGHT:", e.message); if (e.stack) console.log(e.stack.split("\n").slice(1,4).join("\n")); process.exit(1); });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: () => {} }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); if (e.stack) console.log(e.stack.split("\n").slice(1,6).join("\n")); } }
