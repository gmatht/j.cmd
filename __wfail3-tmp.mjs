import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = [];
for (let i = 0; i < 10; i++) KEYS.push("");
KEYS.push("q,");
let keyFrame = 0;
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
  else if (cmd === "bash") { out = ""; }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: { write: () => {} }, stderr: { write: () => {} }, args: [], argv0: "bash" });
const origWrite = rt.sh2.fs.writeFile.bind(rt.sh2.fs);
let cubeWrites = 0;
rt.sh2.fs.writeFile = async (p, data) => {
  if (String(p).includes("buffer/cube")) {
    cubeWrites++;
    if (cubeWrites <= 2) console.log("cube write", cubeWrites, "len", String(data).length, "data ok:", typeof data === "string");
  }
  return origWrite(p, data);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await Promise.race([fn([], fs, {}, { write: () => {} }, { write: () => {} }, shellExec, rt.sh2), new Promise((_, rej) => setTimeout(() => rej(new Error("stop")), 30000))]); }
catch (e) { if (e.message !== "stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
console.log("cube buffer writes:", cubeWrites);
