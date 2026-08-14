import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("examples/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = [];
for (const k of ["q"]) for (let i = 0; i < 6; i++) KEYS.push(k + ",");
let keyFrame = 0, sleepCount = 0;
const stdout = [];
let shellExec = async (cmdline) => {
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 3000) throw new Error("stop"); await new Promise(r => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "bash") { out = "  fake-tex-tsv\n"; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const trace2 = [];
const origWrite = fs.write.bind(fs);
fs.write = async (path, content) => {
  trace2.push(["W", fs._resolve(path), String(content).slice(0, 30), sleepCount]);
  return origWrite(path, content);
};
let lastCmd = "";
const origShell = shellExec;
const shellExec2 = async (cmdline) => {
  lastCmd = cmdline.trim().slice(0, 50);
  trace2.push(["C", lastCmd, "", sleepCount]);
  return origShell(cmdline);
};
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
shellExec = shellExec2;
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
console.log("finished, sleeps:", sleepCount);
console.log("last stdout:", JSON.stringify(stdout.slice(-6)));
console.log("last 12 ops:", JSON.stringify(trace2.slice(-12)));
// periodic dump in case of a hang
setInterval(() => {
  if (trace2.length) console.log("[tick] last op:", JSON.stringify(trace2[trace2.length - 1]), "| count:", trace2.length);
}, 5000);
