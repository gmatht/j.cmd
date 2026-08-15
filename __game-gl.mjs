import { readFileSync } from "node:fs";
import gl0 from "gl";
import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { WebGLDevice } from "./src/fs/webgldev.js";
let ensureCount = 0;
WebGLDevice.prototype._ensureGL = function () {
  ensureCount++;
  if (this._gl) return this._gl;
  this._canvas = { width: 800, height: 600, style: {}, toDataURL: () => "data:," };
  const gl = gl0(800, 600);
  this._gl = gl; this._null = false; this._contextName = "headless-gl";
  try { gl.viewport(0, 0, 800, 600); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } catch {}
  return gl;
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 150) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
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
    new Promise((_, rej) => setTimeout(() => rej(new Error("test-stop")), 40000)),
  ]);
} catch (e) { if (e.message !== "test-stop") process.exit(1); }
let dev = null;
const origWrite2 = WebGLDevice.prototype.write;
let wcount = 0;
WebGLDevice.prototype.write = function (path, data) { dev = this; wcount++; return origWrite2.call(this, path, data); };
const gl = dev && dev._gl;
if (!gl) { const d = fs.mounts.find(m => m.name === "dev"); console.log("mount:", !!d, "ensure:", ensureCount, "gl:", d && d.backend && d.backend._gl ? "yes" : "no", "ctx:", d && d.backend && d.backend._contextName); process.exit(0); }
const px = Buffer.alloc(800 * 600 * 4);
gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
const sample = (x, y) => { const i = ((600 - 1 - y) * 800 + x) * 4; return [px[i], px[i+1], px[i+2]]; };
const grid = [];
for (const [x, y] of [[400,350],[400,400],[400,450],[300,400],[500,400],[400,300],[200,450],[600,450]]) grid.push("("+x+","+y+"):["+sample(x,y)+"]");
console.log("pixels:", grid.join(" "));
console.log("gl err:", gl.getError());
