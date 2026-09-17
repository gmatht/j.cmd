import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0", "MIMES_ON=1");
src = src.replace("*headless*) sound=$((0)); headless=$((0)) ;;", "*headless*) sound=$((0)); headless=$((1)) ;;");
const { js } = await bashToJS(fs, src);
let sleepCount = 0;
const startup = [];
const stdoutLog = [];
const texWrites = [];
let shellExec;
shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") out = ",\n";
    else { try { out = await fs.read(p); } catch { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 200) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "bash") {
    try {
      const content = await fs.read(rest.split(/\s+/)[0]);
      let o = "";
      await runBash(fs, content, { stdout: { write: (s) => { o += s; } }, stderr: { write: () => {} }, runCmd: shellExec, args: rest.split(/\s+/).slice(1), argv0: "bash" });
      out = o;
    } catch (e) { out = ""; }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => { stdoutLog.push(s); const t = s.trim(); if (t && !t.includes("▒") && (t.includes("…") || t.includes("loading") || t.includes("ready"))) startup.push(t); } };
const origWrite = fs.write.bind(fs);
fs.write = async (p, data) => {
  const sp = String(p);
  if (sp.includes("/dev/webgl/texture/")) texWrites.push(sp.split("texture/")[1] + ":" + String(data).trim().split(/\s+/).length + "tok");
  return origWrite(p, data);
};
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: () => {} }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try {
  await Promise.race([
    fn([], fs, {}, out, { write: () => {} }, shellExec, rt.sh2),
    new Promise((_, rej) => setTimeout(() => rej(new Error("test-stop")), 90000)),
  ]);
} catch (e) { if (e.message !== "test-stop") process.exit(1); }
console.log("STARTUP:", JSON.stringify(startup.slice(0, 6)));
console.log("RAW:", JSON.stringify(stdoutLog.slice(0, 8)));
console.log("TEX:", texWrites.slice(0, 16).join(" | "));
