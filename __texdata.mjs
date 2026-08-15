import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0", "MIMES_ON=1");
src = src.replace("*headless*) sound=$((0)); headless=$((0)) ;;", "*headless*) sound=$((0)); headless=$((1)) ;;");
const { js } = await bashToJS(fs, src);
const KEYS = ["q,"];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
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
    if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else { try { out = await fs.read(p); } catch { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 250) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "bash") {
    const parts = rest.split(/\s+/);
    const f = parts[0];
    try {
      const content = await fs.read(f);
      let o = "";
      await runBash(fs, content, { stdout: { write: (s) => { o += s; } }, stderr: { write: () => {} }, runCmd: shellExec, args: parts.slice(1), argv0: "bash" });
      out = o;
    } catch (e) { out = ""; }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const origWrite = fs.write.bind(fs);
fs.write = async (p, data) => {
  const s = String(p);
  if (s.includes("/dev/webgl/texture/")) { texWrites.push({ p: s, d: String(data) }); }
  return origWrite(p, data);
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: { TEX_SIZE: "16", TEX_SEED: "20240812" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try {
  await Promise.race([
    fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2),
    new Promise((_, rej) => setTimeout(() => rej(new Error("test-stop")), 90000)),
  ]);
} catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
console.log("texture writes:", texWrites.length);
for (const t of texWrites) {
  const nums = t.d.trim().split(/[\s,]+/).map(Number);
  const nz = nums.filter((n) => n !== 0).length;
  const uniq = new Set(nums.filter((n) => n > 0)).size;
  console.log(t.p.replace("/dev/webgl/texture/", "tex#"), "| nums:", nums.length, "| non-zero:", nz, "| distinct colours:", uniq, "| head:", t.d.trim().slice(0, 26));
}
