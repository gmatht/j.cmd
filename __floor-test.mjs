// ─── __floor-test.mjs — the y=0 floor cubes are replaced by ONE
// repeating-texture plane: verify headless that (a) the background
// plane is drawn at y=0.45 with the dirt texture (tx=8), (b) the
// per-frame cube payload drops by ~200 (the 16×16 dirt floor), and
// (c) the obsidian y=0 border ring still draws as cubes.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = []; for (let i = 0; i < 90; i++) KEYS.push(""); KEYS.push("q,");
let keyFrame = 0;
const stdout = [];
const blocksWrites = [];   // every /dev/webgl/blocks payload
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") { try { out = await fs.read(fs._resolve(rest.split(/\s+/)[0])); } catch { out = ""; } }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
// the transpiled game reads /dev/webgl/key DIRECTLY (sh2.fs.readFile) —
// feed the scripted keys through the same bridge the browser uses
const origRead = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") {
    const k = keyFrame < KEYS.length ? KEYS[keyFrame] : "q,";
    keyFrame++;
    return k;
  }
  return origRead(p, enc);
};
// and captures /dev/webgl/blocks payloads (echo "$bg_p"/"$blk_p" >
// /dev/webgl/blocks lowers to a direct writeFile)
const origWrite = rt.sh2.fs.writeFile.bind(rt.sh2.fs);
rt.sh2.fs.writeFile = async (p, data) => {
  if (String(p) === "/dev/webgl/blocks") blocksWrites.push(String(data));
  return origWrite(p, data);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { console.log("RUN ERROR:", e.message); process.exit(1); }

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

// each frame = one bg write (2 plane lines) + one blk write (cubes)
const lines = blocksWrites.map((w) => w.trim().split("\n").filter(Boolean));
const planeWrites = lines.filter((ls) => ls.some((l) => l.split(/\s+/)[0] === String(blocksWrites[0].trim().split("\n")[0].split(/\s+/)[0]) && l.includes(" 40 ") && l.includes(" 0.1 ")));
// simpler: any line with sx=40 is a plane
const allPlaneLines = lines.flat().filter((l) => {
  const n = l.split(/\s+/).map(Number);
  return n.length >= 11 && n[3] === 40 && n[4] === 0.1 && n[5] === 40;
});
const allCubeLines = lines.flat().filter((l) => {
  const n = l.split(/\s+/).map(Number);
  return n.length >= 11 && n[3] === 1 && n[4] === 1 && n[5] === 1;
});
check("plane lines found (floor + ceiling, sx=40)", allPlaneLines.length >= 2, allPlaneLines.length + " lines");
const floorLine = allPlaneLines.find((l) => l.split(/\s+/)[1] === "0.45");
check("floor plane at y=0.45 (top face y=0.5, the old dirt-cube top)", !!floorLine, (floorLine || "").trim());
check("floor plane uses the DIRT texture tx=8", !!floorLine && floorLine.split(/\s+/)[9] === "8", (floorLine || "").trim());
check("floor plane is full-bright (1 1 1 — texture untinted)", !!floorLine && floorLine.split(/\s+/)[6] === "1" && floorLine.split(/\s+/)[7] === "1", (floorLine || "").trim());
// the dirt floor cubes (brown 0.55 0.35 0.20 at y=0) must be GONE
const dirtCubes = allCubeLines.filter((l) => {
  const n = l.split(/\s+/).map(Number);
  return n[1] === 0 && n[6] === 0.55 && n[7] === 0.35 && n[8] === 0.2;
});
check("no y=0 dirt cubes in any frame payload", dirtCubes.length === 0, dirtCubes.length + " found");
// the obsidian border ring (y=0, tx=10) still draws as cubes
const obsidianFloor = allCubeLines.filter((l) => l.split(/\s+/)[1] === "0" && l.split(/\s+/)[9] === "10");
check("obsidian y=0 border ring still draws as cubes", obsidianFloor.length > 0, obsidianFloor.length + " lines");
// per-frame cube payload: bg (2 planes) + blk (walls+mimes+obsidian ring)
const frames = [];
for (let i = 0; i + 1 < lines.length; i += 2) frames.push([lines[i].length, lines[i + 1].length]);
const blkCounts = frames.map((f) => f[1]);
const bgCounts = frames.map((f) => f[0]);
console.log("  frames:", frames.length, " bg:", Math.max(...bgCounts), " blk max:", Math.max(...blkCounts), " (old floor alone was 256 cubes)");
check("background writes are exactly 2 planes", bgCounts.every((n) => n === 2));
check("block payload max < 240 (dirt floor gone; walls+mimes+obsidian ring only)", Math.max(...blkCounts) < 240, "max=" + Math.max(...blkCounts));
process.exit(fails ? 1 : 0);
