import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { WebGLDevice } from "./src/fs/webgldev.js";
const T = { blocks: 0, blocksN: 0, hud: 0, hudN: 0, swap: 0, swapN: 0, clear: 0, clearN: 0, other: 0 };
const t0 = performance.now();
const origBlocks = WebGLDevice.prototype._drawBlocks;
WebGLDevice.prototype._drawBlocks = function (text) {
  const s = performance.now();
  const r = origBlocks.call(this, text);
  T.blocks += performance.now() - s; T.blocksN++;
  return r;
};
const origWrite = WebGLDevice.prototype.write;
WebGLDevice.prototype.write = function (path, data) {
  const sp = String(path);
  const s = performance.now();
  const r = origWrite.call(this, path, data);
  const d = performance.now() - s;
  if (sp.includes("/hud/")) { T.hud += d; T.hudN++; }
  else if (sp.includes("/call") && String(data).includes("swap")) { T.swap += d; T.swapN++; }
  else if (sp.includes("/call") && String(data).includes("clear")) { T.clear += d; T.clearN++; }
  else T.other += d;
  return r;
};
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0", "MIMES_ON=1");
src = src.replace("*headless*) sound=$((0)); headless=$((0)) ;;", "*headless*) sound=$((0)); headless=$((1)) ;;");
const { js } = await bashToJS(fs, src);
let sleepCount = 0;
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 700) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
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
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: { write: () => {} }, stderr: { write: () => {} }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try {
  await Promise.race([
    fn([], fs, {}, { write: () => {} }, { write: () => {} }, shellExec, rt.sh2),
    new Promise((_, rej) => setTimeout(() => rej(new Error("test-stop")), 60000)),
  ]);
} catch (e) { if (e.message !== "test-stop") process.exit(1); }
const total = performance.now() - t0;
console.log(`window: ${(total/1000).toFixed(1)}s | draws: ${T.blocksN} (${(T.blocksN / (total/1000)).toFixed(1)} fps)`);
console.log(`device blocks: ${T.blocks.toFixed(0)}ms (${(100*T.blocks/total).toFixed(0)}%) | hud writes: ${T.hud.toFixed(0)}ms (${T.hudN}) | swap: ${T.swap.toFixed(0)}ms (${T.swapN}) | clear: ${T.clear.toFixed(0)}ms (${T.clearN}) | other writes: ${T.other.toFixed(0)}ms`);
