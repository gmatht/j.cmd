// ─── __arrows-test.mjs — ArrowUp/ArrowDown must move fwd/back, not both fwd
// ArrowUp/ArrowDown contain the letter 'w' — if the key case doesn't
// match them BEFORE *w*, both move the player FORWARD.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = ["ArrowUp,", "ArrowUp,", "ArrowDown,", "ArrowDown,", "q,"];
let keyFrame = 0, sleepCount = 0, timeReads = 0;
const stdout = [];
const settled = [];   // [z] after each completed glide
let curZ = null, lastSettled = null;
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else if (p === "/dev/time") { timeReads++; out = (Math.max(0, timeReads - 2) * 5) + "\n"; }   // anim_el=0 on the first render, +5ms/frame after
    else { try { out = await fs.read(p); } catch { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 600) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const origWrite = fs.write.bind(fs);
fs.write = async (path, content) => {
  const p = fs._resolve(path);
  const s = String(content);
  if (p === "/dev/webgl/uniform/3f/uCamPos") {
    const v = s.trim().split(/\s+/);
    const z = Number(v[2]);
    // settled = integer cell (animation complete)
    if (Number.isInteger(z) && z !== lastSettled) { lastSettled = z; settled.push(z); }
  }
  return origWrite(path, content);
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
console.log("settled z after each glide:", settled.join(" → "), "(spawn z=2; ArrowUp→-z, ArrowDown→+z)");
let fails = 0;
// Timing-independent: the first frame's JIT warmup can complete the
// first glide before the spawn value is captured, so check the DELTAS
// (the direction of each move). With the *w* fall-through bug BOTH
// arrows move -z — no +z delta ever appears.
if (settled.length < 2) { console.log("FAIL: too few moves recorded"); process.exit(1); }
const deltas = [];
for (let i = 1; i < settled.length; i++) deltas.push(settled[i] - settled[i - 1]);
const movedFwd = deltas.some((d) => d < 0);   // ArrowUp = forward = -z
const movedBack = deltas.some((d) => d > 0);  // ArrowDown = back = +z
console.log(`${movedFwd ? "PASS" : "FAIL"}: ArrowUp moved -z (deltas ${deltas.join(",")})`);
if (!movedFwd) fails++;
console.log(`${movedBack ? "PASS" : "FAIL"}: ArrowDown moved +z (deltas ${deltas.join(",")})`);
if (!movedBack) fails++;
if (fails) { console.log("ARROWS: FAIL"); process.exit(1); }
console.log("ARROWS: PASS");
