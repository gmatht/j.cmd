// ─── __radar-blip-check.mjs — MIME blips must fit the radar cell box ──
// Radar cells are spaced 44 milli (x) × 60 milli (z); the MIME blip
// (ring + core) and its erase rect must stay within one cell box.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0", "MIMES_ON=1");
const { js } = await bashToJS(fs, src);
// keep the game running a while so mimes spawn and move on the radar
const KEYS = [];
for (let i = 0; i < 40; i++) KEYS.push(["w,", "w,", "ArrowRight,", "w,", "space,", "ArrowLeft,"][i % 6]);
KEYS.push("q,");
let keyFrame = 0, sleepCount = 0;
const stdout = [];
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 2500) throw new Error("stop"); await new Promise(r => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
// the current wasm reads `keys=$(cat /dev/webgl/key)` as a DIRECT device
// read (`sh2.fs.readFile`) — feed the scripted keys through that bridge
const origReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") {
    const k = keyFrame < KEYS.length ? KEYS[keyFrame] : "q,";
    keyFrame++;
    return k;
  }
  return origReadFile(p, enc);
};
const hudPayloads = [];
const origWrite = fs.write.bind(fs);
fs.write = async (path, content) => {
  const p = fs._resolve(path);
  if (p === "/dev/webgl/hud") hudPayloads.push(String(content));
  return origWrite(path, content);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }

// HUD rect lines: "<x> <y> <w> <h> <r> <g> <b>" (NDC decimals)
// Ring color is 0.10 0.10 0.12. Cell box = 0.044 wide × 0.060 tall.
// Triangle (T size 0.042): 42×42 at rest, ≤47×47 worst mid-turn sweep.
// Erase design (radar region only, cy ≤ 0.72):
//   move    44×44  (cell width; covers the 42 rest box, no neighbour damage)
//   rotate  62×60  (covers the 47 sweep + ~2px antialias margin)
//   MIME    40×52  (covers the 36×48 ring inside the cell box)
const CELL_W = 0.044, CELL_H = 0.060;
let ring = 0, core = 0, badRing = 0, badCore = 0, badErase = 0, erases = 0, mimeErases = 0, triErases = 0, badTriErase = 0;
const KNOWN = [[0.040, 0.052], [0.044, 0.044], [0.062, 0.060]];
for (const l of hudPayloads.join("\n").split("\n")) {
  const n = l.trim().split(/\s+/);
  if (n.length < 5) continue;
  if (n[0] === "E") { // erase: E cx cy w h (NDC)
    erases++;
    const w = parseFloat(n[3]), h = parseFloat(n[4]);
    const cy = parseFloat(n[2]);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    if (near(w, 0.040) && near(h, 0.052)) {
      // MIME blip erase: must cover the 36×48 ring inside the cell box
      mimeErases++;
      if (w < 0.036 || h < 0.048 || w > CELL_W + 1e-6 || h > CELL_H + 1e-6) badErase++;
    } else if (near(w, 0.044) && near(h, 0.044)) {
      // move erase: covers the 42 triangle, stays within the cell width
      triErases++;
      if (w > CELL_W + 1e-6) badTriErase++;
    } else if (near(w, 0.062) && near(h, 0.060)) {
      // rotate erase: covers the 47 worst-case sweep with margin
      triErases++;
      if (w < 0.047 || h < 0.047) badTriErase++;
    } else if (cy <= 0.72 + 1e-6 && w >= 0.04 - 1e-6 && w <= 0.2 + 1e-6) {
      // an UNKNOWN radar-sized erase (old 64/132/80/105 or a future
      // regression) — flag it
      badTriErase++;
    }
    continue;
  }
  if (n.length < 7) continue;
  const [x, y, w, h, r, g, b] = n.map(parseFloat);
  const ringLine = r === 0.10 && g === 0.10 && b === 0.12;
  const isBlip = ringLine || (r === 0.95 && g === 0.55 && b === 0.15) || (r === 0.20 && g === 0.75 && b === 0.25) ||
                 (r === 0.65 && g === 0.65 && b === 0.65) || (r === 0.90 && g === 0.90 && b === 0.90);
  if (!isBlip) continue;
  if (ringLine) ring++;
  else core++;
  const fits = w <= CELL_W + 1e-6 && h <= CELL_H + 1e-6;
  if (ringLine) { if (!fits) badRing++; }
  else if (!fits) badCore++;
}
console.log(`blip ring rects: ${ring} (too big: ${badRing})`);
console.log(`blip core rects: ${core} (too big: ${badCore})`);
console.log(`erase rects seen: ${erases} | MIME erases: ${mimeErases} (bad: ${badErase}) | triangle erases: ${triErases} (bad: ${badTriErase})`);
if (badRing || badCore || badErase || badTriErase) { console.log("FAIL: some radar rects still overflow their cell box"); process.exit(1); }
if (ring === 0) { console.log("NOTE: no blips observed this run"); }
else console.log("OK: all MIME blips + erases fit their 44×60 radar cell");
