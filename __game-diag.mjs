import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((1)); headless=0 ;;");
const { js } = await bashToJS(fs, src);
const KEYS = ["Escape,", "q,"];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const origRead = fs.read.bind(fs);
fs.read = async (p, o) => {
  const s = String(p);
  if (s.includes("webgl/key")) { const k = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; return k; }
  return origRead(p, o);
};
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  const rest = cl.slice(cmd.length).trim();
  let out = "";
  if (cmd === "bash" || cmd === "/bin/bash") {
    const args2 = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
    try { out = execFileSync("bash", args2, { encoding: "utf8" }); } catch { out = ""; }
  }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 20000) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(String(s)) };
const proc = { stdout: out, stderr: { write: (s) => stdout.push(String(s)) }, pid: 1, argv: [], env: {}, cwd: () => "/", chdir() {}, exit() {} };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: proc.stderr, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "process", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, proc.stderr, shellExec, rt.sh2, proc); } catch (e) { if (e.message !== "test-stop") console.log("run err:", e.message); }
const txt = stdout.join("");
console.log("=== errors:"); for (const l of txt.split("\n")) if (/undefined|fi:|not found|FAILED|blocks:|program:/.test(l)) console.log("  " + l);
console.log("=== frag program (CRT/CORRUPT OFF):");
try { const p = await fs.read("/tmp/mimecroft-frag.sh"); console.log(p.split("\n").filter(Boolean).join("\n")); } catch (e) { console.log("(no frag program: " + e.message + ")"); }
console.log("=== webgl log:");
try { const lg = await fs.read("/dev/webgl/log"); console.log(lg.split("\n").filter(l => /shader|program/.test(l)).join("\n")); } catch (e) { console.log("(no log: " + e.message + ")"); }
