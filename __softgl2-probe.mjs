// ─── __softgl2-probe.mjs — FULL pipeline (geometry + fragment shader) ─
// Renders real game frames through the exact vertex shader (w-projection)
// AND the exact fragment shader (vColor = aShade·uBlockColor·texture,
// CRT scanlines, corruption streaks, vignette) to compute what the user
// actually SEES — mean luminance and the fraction of "readable" pixels.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

const W = 80, H = 60;
const aPos = new Float32Array("-0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 -0.5 -0.5".split(/\s+/).map(Number));
// aShade per face (6 faces × 12 values, matching the device buffer)
const aShade = [0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9, 0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9, 1,1,1,1,1,1,1,1,1,1,1,1, 0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8,0.8, 0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95,0.95, 0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85,0.85];
const cubeI = [0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11,12,13,14,12,14,15,16,17,18,16,18,19,20,21,22,20,22,23];
// texture averages (from the real generators) as flat tints per tex index
const TEX_TINT = { 0: [1,1,1], 1: [0.50,0.50,0.50], 2: [0.64,0.60,0.52], 3: [0.36,0.42,0.50], 4: [0.52,0.42,0.40], 5: [0.40,0.46,0.35], 6: [0.33,0.40,0.28], 7: [0.40,0.33,0.26], 8: [0.30,0.27,0.24] };

function renderFrame(blocks, camPos, yawDeg) {
  const depth = new Float32Array(W * H).fill(1.0);
  const pix = new Float32Array(W * H * 3).fill(0.05);   // clear color r,g,b
  const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const cam = [camPos[0], 0.5, camPos[1]];   // the shader eye: player cell centre, half a block up
  for (const line of blocks.trim().split("\n")) {
    const [x, y, z, sx, sy, sz, r, g, b, tx] = line.split(/\s+/).map(Number);
    const tint = TEX_TINT[tx] || [1, 1, 1];
    for (let t = 0; t < 12; t++) {
      const face = Math.floor(t / 2), shade = aShade[face * 12];
      const i0 = cubeI[t*3], i1 = cubeI[t*3+1], i2 = cubeI[t*3+2];
      const clip = [[i0],[i1],[i2]].map(([v]) => {
        const px = aPos[v*3]*sx + x, py = aPos[v*3+1]*sy + y, pz = aPos[v*3+2]*sz + z;
        const d = [px-cam[0], py-cam[1], pz-cam[2]];
        const rel = [d[0]*c + d[2]*s, d[1], -d[0]*s + d[2]*c];
        const w = -rel[2];
        return { x: rel[0]*0.9, y: rel[1]*0.9, z: w*w/64.0, w };
      });
      const poly = [];
      for (let i = 0; i < clip.length; i++) {
        const v0 = clip[i], v1 = clip[(i+1) % clip.length];
        const in0 = v0.w > 0, in1 = v1.w > 0;
        if (in0) poly.push(v0);
        if (in0 !== in1) {
          const tt = v0.w / (v0.w - v1.w);
          poly.push({ x: v0.x + tt*(v1.x-v0.x), y: v0.y + tt*(v1.y-v0.y), z: v0.z + tt*(v1.z-v0.z), w: 0 });
        }
      }
      if (poly.length < 3) continue;
      for (let i = 1; i < poly.length - 1; i++) {
        // w=0 boundary verts sit on the near plane: x/w,y/w → ±∞ (clipped
        // by the raster bbox), depth → 0.5 (z/w = w/64 → 0 as w→0+)
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
        // fragment color = aShade·uBlockColor·texture (flat tint)
        const fr = shade * r * tint[0], fg = shade * g * tint[1], fb = shade * b * tint[2];
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
              depth[idx] = dd;
              // fragment shader: CRT scanline, corruption, vignette
              let rr = fr * 255, gg = fg * 255, bb = fb * 255;
              if (py % 6 === 0) { rr *= 0.9; gg *= 0.9; bb *= 0.9; }
              const hsh = (px * 7 + py * 13) % 97;
              if (hsh === 0) { rr = 255; gg *= 0.5; bb *= 0.5; }
              const edge = Math.abs(px * 10 - 400) + Math.abs(py * 10 - 300);
              if (edge > 450) { let dim = Math.min(edge - 450, 30); rr -= dim; gg -= dim; bb -= dim; }
              pix[idx*3] = Math.max(0, rr) / 255; pix[idx*3+1] = Math.max(0, gg) / 255; pix[idx*3+2] = Math.max(0, bb) / 255;
            }
          }
        }
      }
    }
  }
  // mean luminance + fraction above a "readable" threshold
  let sum = 0, readable = 0, nanPix = 0;
  for (let i = 0; i < W * H; i++) {
    const l = 0.299*pix[i*3] + 0.587*pix[i*3+1] + 0.114*pix[i*3+2];
    if (!Number.isFinite(l)) { nanPix++; continue; }
    sum += l;
    if (l > 0.10) readable++;
  }
  return { mean: sum / (W * H), readable: readable / (W * H), nanPix };
}

// ── drive the game ──────────────────────────────────────────────────
const src = readFileSync("examples/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = [];
for (const k of ["w","w","w","w","s","s","s","ArrowRight","w","w","w","ArrowLeft","w","w","w","s","s","s","ArrowLeft","w","w","q"]) { for (let i = 0; i < 6; i++) KEYS.push(k + ","); }
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const frames = [];
let curBlocks = null, curPos = null, curYaw = null;
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 2000) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const origWrite = fs.write.bind(fs);
fs.write = async (path, content) => {
  const p = fs._resolve(path);
  const s = String(content);
  if (p === "/dev/webgl/blocks") curBlocks = s;
  else if (p === "/dev/webgl/uniform/3f/uCamPos") { const v = s.trim().split(/\s+/); curPos = [Number(v[0]), Number(v[2])]; }
  else if (p === "/dev/webgl/uniform/1f/uCamYaw") curYaw = Number(s.trim());
  else if (p === "/dev/webgl/call" && s.trim() === "swap") {
    if (curBlocks && curPos && curYaw !== null) frames.push({ blocks: curBlocks, pos: curPos, yaw: curYaw });
  }
  return origWrite(path, content);
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }

const stats = [];
for (const f of frames) stats.push(renderFrame(f.blocks, f.pos, f.yaw));
const nans = stats.filter((s) => s.nanPix > 0).length;
const meanAll = stats.reduce((a, s) => a + s.mean, 0) / stats.length;
const readableAll = stats.reduce((a, s) => a + s.readable, 0) / stats.length;
const worst = stats.reduce((a, s) => Math.min(a, s.readable), 1);
console.log(`${frames.length} frames | ${nans} frames with NaN pixels | mean luminance ${meanAll.toFixed(3)} | mean readable ${(readableAll*100).toFixed(1)}% | worst frame readable ${(worst*100).toFixed(1)}%`);
const worstFrames = stats.map((s, i) => ({ ...s, i })).sort((a, b) => a.readable - b.readable).slice(0, 5);
for (const w of worstFrames) console.log(`  worst #${w.i}: pos(${frames[w.i].pos[0]},${frames[w.i].pos[1]}) yaw ${frames[w.i].yaw}° readable ${(w.readable*100).toFixed(1)}% mean ${w.mean.toFixed(3)}`);
console.log(readableAll > 0.5 ? "FULL-PIPE: world is clearly visible (blank screen is NOT the shading)" : "FULL-PIPE: world renders dark — shading IS the blank-screen cause");
