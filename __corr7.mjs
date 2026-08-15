// __corr7.mjs — capture the real first frame through the __mime-test
// harness (which runs the game) and render it with the exact shader.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

const W = 140, H = 46;
const aPos = new Float32Array("-0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 -0.5 -0.5".split(/\s+/).map(Number));
const cubeI = [0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11,12,13,14,12,14,15,16,17,18,16,18,19,20,21,22,20,22,23];
const P = 0.45;
const aShade = (process.env.SHADE ? process.env.SHADE.split(",").map(Number) : [0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9, 0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9, 1,1,1,1,1,1,1,1,1,1,1,1, 0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8, 0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95, 0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85]);

function render(blocks, camPos, yawDeg) {
  const depth = new Float32Array(W * H).fill(1.0);
  const pix = new Array(W * H).fill(".");
  const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const eye = [camPos[0], camPos[1] + 0.5, camPos[2]];
  const chOf = (line) => {
    const n = line.trim().split(/\s+/).map(Number);
    return "x";
  };
  const draw = (payload, writeDepth) => {
    for (const line of payload.split("\n")) {
      const n = line.trim().split(/\s+/).map(Number);
      if (n.length < 3) continue;
      const ch = chOf(line);
      const [x, y, z, sx, sy, sz] = n;
      for (let t = 0; t < 12; t++) {
        const face = Math.floor(t / 2), shade = aShade[face * 12];
        const i0 = cubeI[t*3], i1 = cubeI[t*3+1], i2 = cubeI[t*3+2];
        const clip = [[i0],[i1],[i2]].map(([v]) => {
          const px = aPos[v*3]*sx + x, py = aPos[v*3+1]*sy + y, pz = aPos[v*3+2]*sz + z;
          const d = [px-eye[0], py-eye[1], pz-eye[2]];
          const rel = [d[0]*c + d[2]*s, d[1], -d[0]*s + d[2]*c];
          const w = -rel[2];
          return { x: rel[0]*P, y: rel[1]*P, z: w*w/64.0, w };
        });
        const poly = [];
        for (let i = 0; i < clip.length; i++) {
          const v0 = clip[i], v1 = clip[(i+1) % clip.length];
          const in0 = v0.w > 0, in1 = v1.w > 0;
          if (in0) poly.push(v0);
          if (in0 !== in1) { const tt = v0.w / (v0.w - v1.w); poly.push({ x: v0.x + tt*(v1.x-v0.x), y: v0.y + tt*(v1.y-v0.y), z: v0.z + tt*(v1.z-v0.z), w: 0 }); }
        }
        if (poly.length < 3) continue;
        for (let i = 1; i < poly.length - 1; i++) {
          const ndc = [poly[0], poly[i], poly[i+1]].map((v) => ({
            x: v.w === 0 ? (v.x === 0 ? 0 : (v.x > 0 ? 1e6 : -1e6)) : v.x / v.w,
            y: v.w === 0 ? (v.y === 0 ? 0 : (v.y > 0 ? 1e6 : -1e6)) : v.y / v.w,
            d: v.w === 0 ? 0.5 : (v.z / v.w + 1) / 2,
          }));
          let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          for (const v of ndc) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
          if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) continue;
          const sx0 = Math.max(0, Math.floor((minX + 1) / 2 * W)), sx1 = Math.min(W - 1, Math.ceil((maxX + 1) / 2 * W));
          const sy0 = Math.max(0, Math.floor((1 - maxY) / 2 * H)), sy1 = Math.min(H - 1, Math.ceil((1 - minY) / 2 * H));
          const area = (v0, v1, v2) => (v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x);
          const A = area(ndc[0], ndc[1], ndc[2]);
          if (Math.abs(A) < 1e-9) continue;
          for (let py = sy0; py <= sy1; py++) {
            const ndcY = 1 - (py + 0.5) / H * 2;
            for (let px = sx0; px <= sx1; px++) {
              const ndcX = (px + 0.5) / W * 2 - 1;
              const p = { x: ndcX, y: ndcY };
              const a0 = area(ndc[1], ndc[2], p), a1 = area(ndc[2], ndc[0], p), a2 = area(ndc[0], ndc[1], p);
              const s0 = a0 / A, s1 = a1 / A, s2 = a2 / A;
              if (s0 < -1e-6 || s1 < -1e-6 || s2 < -1e-6) continue;
              const dd = s0 * ndc[0].d + s1 * ndc[1].d + s2 * ndc[2].d;
              const idx = py * W + px;
              if (dd <= depth[idx]) {
                if (writeDepth) depth[idx] = dd;
                const lum = Math.round((shade * n[6]) * 9);
                pix[idx] = "0123456789"[Math.max(0, Math.min(9, lum))];
              }
            }
          }
        }
      }
    }
  };
  for (const l of blocks.split("\n")) if (l.trim().split(/\s+/).map(Number)[3] === 40) draw(l, false);
  for (const l of blocks.split("\n")) if (l.trim().split(/\s+/).map(Number)[3] !== 40) draw(l, true);
  return pix;
}

// ── the __mime-test harness (works) + frame capture ─────────────────
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEY_SCRIPT = ["q,"];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const frames = [];
let curBlocks = null, curPos = null, curYaw = null;
const shellExec = async (cmdline, stdin) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,"; keyFrame++; out = k + "\n"; }
    else { try { out = await fs.read(p); } catch (e) { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 4000) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "bash") { out = ""; }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const oSh2ReadFile = rt0 => null;
const out = { write: (s) => stdout.push(s) };
const err = { write: (s) => stdout.push("[err] " + s) };
const ow = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { stdout.push(String(s)); return ow(s, ...rest); };
const rt = createSh2Runtime({ fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") { const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,"; keyFrame++; return k; }
  return origSh2ReadFile(p, enc);
};
const origSh2WriteFile = rt.sh2.fs.writeFile.bind(rt.sh2.fs);
rt.sh2.fs.writeFile = async (p, content) => {
  const s = String(content);
  if (String(p) === "/dev/webgl/blocks") curBlocks = s;
  else if (String(p) === "/dev/webgl/uniform/3f/uCamPos") { const v = s.trim().split(/\s+/); curPos = [Number(v[0]), Number(v[1]), Number(v[2])]; }
  else if (String(p) === "/dev/webgl/uniform/1f/uCamYaw") curYaw = Number(s.trim());
  else if (String(p) === "/dev/webgl/call" && s.trim() === "swap") { if (curBlocks && curPos && curYaw !== null) frames.push({ blocks: curBlocks, pos: curPos, yaw: curYaw }); }
  return origSh2WriteFile(p, content);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home", USER: "tinysh" }, out, err, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
process.stdout.write = ow;

console.log(`${frames.length} frames captured`);
if (frames.length === 0) process.exit(0);
for (const [fi, f] of frames.slice(0, 20).entries()) {
  console.log(`frame #${fi}: cam (${f.pos[0]}, ${f.pos[1]}, ${f.pos[2]}) yaw ${f.yaw}° — blocks: ${f.blocks.split("\n").length} lines`);
}
const f = frames[0];
console.log("payload:");
console.log(f.blocks);
console.log(`'#'=stone 'd'=dirt 'O'=obsidian '='=bg (real first frame, cam ${f.pos.join(",")} yaw ${f.yaw})`);
const pix = render(f.blocks, f.pos, f.yaw);
for (let py = 0; py < H; py++) console.log(pix.slice(py*W, (py+1)*W).join(""));
