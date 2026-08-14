import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("examples/mimecroft.sh", "utf8");
src = src.replace("*headless*) sound=$((0)); headless=$((1)) ;;", "*headless*) sound=$((0)); headless=$((0)) ;;");
const { js } = await bashToJS(fs, src);
const KEYS = []; for (let i = 0; i < 60; i++) KEYS.push(""); KEYS.push("q,");
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const frameBlocks = [];
let prevLog = "";
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
  else if (cmd === "sleep") {
    // frame boundary: snapshot the log, extract the writes added this frame
    const log = await fs.read("/dev/webgl/log");
    const added = log.slice(prevLog.length);
    const seq = (added.match(/\[uniform\/3f\/uObjPos\] .*/g) || []).join("|");
    frameBlocks.push(seq);
    prevLog = log;
    sleepCount++;
    if (sleepCount > 300) throw new Error("test-stop");
    await new Promise((r) => setTimeout(r, 0));
  }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
// the FIRST frame includes setup; compare frames 2..60
let flips = 0;
const flipFrames = [];
for (let i = 2; i < frameBlocks.length; i++) {
  if (frameBlocks[i] !== frameBlocks[i - 1]) { flips++; flipFrames.push(i); }
}
const lens = frameBlocks.slice(1, 12).map((s) => s.split("|").length);
console.log("frames:", frameBlocks.length, "| per-frame block counts (f1..f11):", lens.join(","));
console.log("consecutive differences:", flips, "at frames:", flipFrames.slice(0, 12).join(","), "(expect ~6 — mime steps at 10,20,30...)");
