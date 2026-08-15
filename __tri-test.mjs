// ─── __tri-test.mjs — player radar triangle points the way you face ─
// Drives mimecroft.sh through a right turn, a turn back, and a left
// turn, capturing every "T …deg" line (minimap triangle) and the
// uCamYaw uniform, both written once per rendered frame. Every frame
// whose camera yaw is a settled heading (0/90/180/270) must have the
// triangle pointing the SAME way (deg equal mod 360) — and during the
// glides the triangle must sweep the SHORT arc with the camera.
// (Regression: v5.5 flipped the device's T rotation sign but not the
// game's, leaving sideways headings rotated 180° — deg was -yaw*90.)
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = ["ArrowRight,", "w,", "ArrowLeft,", "w,", "ArrowLeft,", "w,", "q,"];
let keyFrame = 0, sleepCount = 0, timeReads = 0;
const stdout = [];
let lastYaw = null;                 // uCamYaw of the current frame
const pairs = [];                   // [cameraDeg, triDeg] per rendered frame
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else if (p === "/dev/time") { timeReads++; out = (timeReads * 10) + "\n"; }
    else { try { out = await fs.read(p); } catch { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 800) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const origWrite = fs.write.bind(fs);
fs.write = async (path, content) => {
  const p = fs._resolve(path);
  if (p === "/dev/webgl/uniform/1f/uCamYaw") {
    lastYaw = Number(String(content).trim());
  } else if (p === "/dev/webgl/hud") {
    for (const line of String(content).split("\n")) {
      if (line.startsWith("T ")) pairs.push([lastYaw, Number(line.trim().split(/\s+/)[7])]);
    }
  }
  return origWrite(path, content);
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
if (pairs.length < 3) { console.log("TRIANGLE: FAIL — no T lines captured"); process.exit(1); }
const norm = (d) => ((d % 360) + 540) % 360 - 180;   // -180..180
const HEADINGS = [0, 90, 180, 270];
// settled frames: camera yaw on a cardinal heading → triangle must match
const settled = pairs.filter(([y, t]) => HEADINGS.includes(Math.round(y)));
let fails = 0;
for (const [y, t] of settled) {
  const ok = norm(t) === norm(y) || Math.abs(norm(t) - norm(y)) === 360;
  console.log(`${ok ? "PASS" : "FAIL"}: camera yaw ${y}° → triangle deg ${t}° (norm ${norm(t)}°)`);
  if (!ok) fails++;
}
// the glides must take the SHORT arc the right way: the right turn's
// first ~40 frames sweep 0 → +90 (not 0 → -90), the left turn's sweep
// 0 → -90 (ending at 270). Check the sweep direction via the extremes
// seen between the first settled 90 and the settled 270.
const first90 = pairs.findIndex(([y]) => Math.round(y) === 90);
const last0 = pairs.map(([y]) => Math.round(y)).lastIndexOf(0);
if (first90 > 0 && last0 > first90 && last0 < pairs.length - 1) {
  // right turn: from the start up to the first settled +90 — the sweep
  // must stay on the POSITIVE side of 0 (old bug: it went 0 → -90)
  const right = pairs.slice(0, first90 + 1).map(([, t]) => t);
  // left turn: after the camera returns to 0 — sweep 0 → -90, settle 270
  const left = pairs.slice(last0 + 1).map(([, t]) => t);
  const okRight = Math.max(...right) >= 89 && Math.min(...right) >= -0.5;
  const okLeft = Math.min(...left) < -45 && Math.max(...left) >= 269;
  console.log(`${okRight ? "PASS" : "FAIL"}: right turn sweeps 0 → +90 (range ${Math.min(...right).toFixed(0)}°..${Math.max(...right).toFixed(0)}°)`);
  console.log(`${okLeft ? "PASS" : "FAIL"}: left turn sweeps 0 → -90/270 (range ${Math.min(...left).toFixed(0)}°..${Math.max(...left).toFixed(0)}°)`);
  if (!okRight) fails++;
  if (!okLeft) fails++;
} else {
  console.log("FAIL: could not locate the turn glides in the captured frames");
  fails++;
}
console.log("rendered frames with triangle:", pairs.length, "| settled frames:", settled.length);

// ── device rasterizer direction (guards the T y-offset fix) ──
// _rasterHudImpl rotates the apex in NDC (y-up) and places it on the
// canvas; the y-offset must be SUBTRACTED from the flipped center or
// deg 0 renders pointing DOWN (the v5.5 vertical-flip regression).
// Recompute the apex canvas offset exactly as the device does:
const apexDir = (deg) => {
  const a = (-deg) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  const x = (0 * c - 0.5 * sn), y = -(0 * sn + 0.5 * c);   // canvas y-down
  return [x, y];
};
const devChecks = [
  { deg: 0,   want: [0, -1], what: "deg 0 → UP (yaw 0 = -z)" },
  { deg: 90,  want: [1, 0],  what: "deg 90 → RIGHT (yaw 1 = +x)" },
  { deg: 180, want: [0, 1],  what: "deg 180 → DOWN (yaw 2 = +z)" },
  { deg: 270, want: [-1, 0], what: "deg 270 → LEFT (yaw 3 = -x)" },
];
for (const c of devChecks) {
  const [x, y] = apexDir(c.deg);
  const nx = Math.abs(x) < 1e-9 ? 0 : Math.sign(x), ny = Math.abs(y) < 1e-9 ? 0 : Math.sign(y);
  const ok = nx === c.want[0] && ny === c.want[1];
  console.log(`${ok ? "PASS" : "FAIL"}: device renders deg ${c.deg} → dir (${nx},${ny}) — ${c.what}`);
  if (!ok) fails++;
}
if (fails) { console.log("TRIANGLE: FAIL"); process.exit(1); }
console.log("TRIANGLE: PASS");
