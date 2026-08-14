import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("examples/mimecroft.sh", "utf8");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=1");
const { js } = await bashToJS(fs, src);
const KEYS = ["w","w","w","w","ArrowRight","ArrowRight","w","w","w","w","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","q,"];
let keyFrame = 0, swaps = 0, blockWrites = 0, renderFrames = 0;
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else { try { out = await fs.read(p); } catch { out = ""; } }
  }
  else if (cmd === "bash") { try { out = execFileSync("bash", rest.split(/\s+/).map(a => a.replace("/examples/", "examples/")), { encoding: "utf8" }); } catch { out = ""; } }
  else if (cmd === "sleep") { await new Promise(r => setTimeout(r, 0)); }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: { write: (s) => stdout.push(String(s)) }, stderr: { write: (s) => stdout.push(String(s)) }, args: [], argv0: "bash" });
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") { const k = keyFrame < KEYS.length ? KEYS[keyFrame] : "q,"; keyFrame++; return k; }
  return origSh2ReadFile(p, enc);
};
const oWriteFile = rt.sh2.fs.writeFile.bind(rt.sh2.fs);
rt.sh2.fs.writeFile = async (p, c) => {
  if (String(p) === "/dev/webgl/blocks") blockWrites++;
  if (String(p) === "/dev/webgl/call" && String(c).includes("swap")) swaps++;
  return oWriteFile(p, c);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, { write: (s) => stdout.push(String(s)) }, { write: (s) => stdout.push(String(s)) }, shellExec, rt.sh2); } catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); } }
console.log("3D render_frame (blocks writes):", blockWrites, "| total swaps:", swaps, "| HUD-only swaps:", swaps - blockWrites);
