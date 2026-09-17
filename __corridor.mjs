// render the deployed game (www/bin/mimecroft.sh) at the spawn; the player
// is at (2,2) facing -z in the carved corridor. Dump the frame + analyze
// the wall block faces.
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import gl0 from "gl";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { WebGLDevice } from "./src/fs/webgldev.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
WebGLDevice.prototype._ensureGL = function () {
  if (this._gl) return this._gl;
  this._canvas = { width: 800, height: 600, style: {}, toDataURL: () => "data:," };
  const gl = gl0(800, 600);
  this._gl = gl; this._null = false; this._contextName = "headless-gl";
  try { gl.viewport(0, 0, 800, 600); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } catch {}
  return gl;
};
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((1)); headless=0 ;;");
const { js } = await bashToJS(fs, src);
const KEYS = ["Escape,", "q,"];
let keyFrame = 0;
let lastCapture = null;
let whiteDone = false;
const origRead = fs.read.bind(fs);
fs.read = async (p, o) => {
  const s = String(p);
  if (s.includes("webgl/key")) { const k = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; return k; }
  return origRead(p, o);
};
const origW = fs.write.bind(fs);
fs.write = async (p, c) => {
  const s = String(p);
  if (s.includes("webgl/texture/") && String(c).trim().split(/\s+/).length > 100 && !whiteDone) {
    // replace each texture payload with a solid mid-gray so faces are uniform
    const nums = String(c).trim().split(/\s+/);
    const size = Number(nums[0]);
    const rep = [String(size)];
    const chan = (nums.length - 1) >= size * size * 4 ? 4 : 3;
    for (let i = 0; i < size * size; i++) { rep.push(180); rep.push(180); rep.push(185); if (chan === 4) rep.push(255); }
    whiteDone = true;
    return origW(p, rep.join(" "));
  }
  if (s.includes("webgl/blocks") && String(c).trim().split("\n").length > 10 && !lastCapture) {
    await origW(p, c);
    const devf = fs._getBackend ? fs._getBackend("/dev") : null;
    const dw = devf && devf._webgl;
    if (dw && dw._gl) {
      const buf = Buffer.alloc(800 * 600 * 4);
      dw._gl.readPixels(0, 0, 800, 600, dw._gl.RGBA, dw._gl.UNSIGNED_BYTE, buf);
      lastCapture = { buf };
    }
    return;
  }
  return origW(p, c);
};
const glslLib = await getOtranspilerl();
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  const rest = cl.slice(cmd.length).trim();
  let out = "";
  if (cmd === "bash" || cmd === "/bin/bash") {
    const args2 = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
    try { out = execFileSync("bash", args2, { encoding: "utf8" }); } catch { out = ""; }
  }
  else if (cmd === "sh2glsl") {
    const f = rest.split(/\s+/).pop().replace("/examples/", "www/examples/");
    try { out = glslLib.glslv(readFileSync(f, "utf8")); } catch { out = ""; }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: () => {} };
const proc = { stdout: out, stderr: { write: () => {} }, pid: 1, argv: [], env: {}, cwd: () => "/", chdir() {}, exit() {} };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: proc.stderr, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "process", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, proc.stderr, shellExec, rt.sh2, proc); } catch (e) { console.log("run err:", e.message); }
if (!lastCapture) { console.log("no capture"); process.exit(1); }
const buf = lastCapture.buf;
// ASCII map with luminance
const at = (x, sy) => { const i = ((600 - 1 - sy) * 800 + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
for (let sy = 590; sy >= 150; sy -= 20) {
  let row = "";
  for (let x = 0; x < 800; x += 20) {
    const c = at(x, sy);
    const lum = (c[0] + c[1] + c[2]) / 3;
    if (lum < 10) row += ".";
    else if (lum < 40) row += "-";
    else if (lum < 80) row += "o";
    else if (lum < 140) row += "#";
    else row += "@";
  }
  console.log(String(sy).padStart(4) + " " + row);
}
// measure a wall block: find the block at the player's left (1,2) — the
// wedge region x 0..~240, rows 340..600. Sample the wedge's width.
let stoneCols = new Set();
for (let y = 400; y < 580; y += 4) {
  for (let x = 0; x < 400; x += 4) {
    const c = at(x, y);
    if (Math.abs(c[0]-c[1]) < 10 && Math.abs(c[1]-c[2]) < 10 && (c[0]+c[1]+c[2])/3 > 30) stoneCols.add(x);
  }
}
if (stoneCols.size) console.log("left wall face x-extent: " + Math.min(...stoneCols) + ".." + Math.max(...stoneCols) + " (" + (Math.max(...stoneCols)-Math.min(...stoneCols)) + "px)");
