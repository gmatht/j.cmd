// ─── __claim2-live.mjs — regression: claiming TWO treasures must not
// end the game (the claim's `return 0` inside its while-loop was
// emitted as a throwing sh2.return(N) whose ReturnSignal escaped the
// direct call and was unwrapped by exec("main") as main's OWN return —
// the game silently ended the frame the first treasure was claimed:
// no ending banner, no error, FPS frozen, no swaps, and the webgl
// device's 2s keyboard-capture window expired, so the keys fell
// through to the terminal).
//
// Speed: the game's 200 ms/cell glide is the wall-clock bottleneck —
// patch ANIM_MS/ANIM_MS_CROUCH down at transpile time (the glide clock
// measures real µs, so the shorter constants make the walk ~7×
// faster) and shorten the startup "ready" pause. The mimes are slowed
// to ~17 s/step so they cannot wander into the planned path and make
// the walk flaky.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("ANIM_MS=200", "ANIM_MS=30");
src = src.replace("ANIM_MS_CROUCH=400", "ANIM_MS_CROUCH=60");
src = src.replace(/^(mime_speed=)15/m, "$11000");   // mimes stay put → deterministic walk
src = src.replace("sleep 0.8", "sleep 0.05");
const { js } = await bashToJS(fs, src);

let shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") { try { out = await fs.read(fs._resolve(rest.split(/\s+/)[0])); } catch { out = ""; } }
  else if (cmd === "sleep") { const s = parseFloat(rest.split(/\s+/)[0]) || 0; await new Promise(r => setTimeout(r, Math.max(0, s * 1000))); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "bash") { out = "  fake-tsv\n"; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const gameOut = [];
const origPw = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...r) => { gameOut.push(String(s)); return origPw(s, ...r); };
const out = { write: (s) => { gameOut.push(String(s)); } };
let webglDev = null;
for (const m of Object.values(fs.mounts || {})) {
  const b = m && m.backend;
  if (b && b._webgl) { webglDev = b._webgl; break; }
}
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => { gameOut.push("[err] " + String(s)); } }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
const T0 = Date.now();
const plan = { keys: [], done: false };
const origRead = webglDev.read.bind(webglDev);
const feed = () => { if (plan.keys.length) webglDev._keys = [plan.keys.shift()]; else webglDev._keys = ["q,"]; };
webglDev.read = async (path) => {
  if (String(path).includes("key")) { feed(); webglDev._keys = [...webglDev._keys]; }
  return origRead(path);
};
webglDev._keys = [];
let runError = null;
const done = fn([], fs, { HOME: "/home" }, out, { write: () => {} }, shellExec, rt.sh2).catch((e) => { runError = e; });

const mapWait = setInterval(() => {
  if (plan.done) return;
  const mi = gameOut.findIndex((s) => String(s).includes("MIMEcroft  artifacts"));
  if (mi < 0) return;
  const rows = [];
  for (let r = mi + 1; r < mi + 17; r++) {
    const t = String(gameOut[r] || "").replace(/^\s*/, "").trim();
    if (/^[.@?#]{16}$/.test(t)) rows.push(t);
  }
  if (rows.length < 16) return;
  const grid = rows.map(r => r.split(""));
  const open = (x, z) => { const c = grid[z] && grid[z][x]; return c === "." || c === "@" || c === "?"; };
  let sx = 0, sz = 0;
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) if (grid[z][x] === "@") { sx = x; sz = z; }
  const bfs = (sx, sz, isTarget) => {
    const dist = new Map(), prev = new Map();
    const q = [[sx, sz]]; dist.set(sx + "," + sz, 0);
    while (q.length) {
      const [x, z] = q.shift();
      if (isTarget(x, z)) return [x, z, dist, prev];
      if (dist.get(x + "," + z) > 80) break;
      for (const [dx, dz] of [[0,1],[1,0],[0,-1],[-1,0]]) {
        const nx = x + dx, nz = z + dz, k = nx + "," + nz;
        if (nx < 0 || nz < 0 || nx > 15 || nz > 15) continue;
        if (dist.has(k) || !open(nx, nz)) continue;
        dist.set(k, dist.get(x + "," + z) + 1); prev.set(k, [x, z]); q.push([nx, nz]);
      }
    }
    return null;
  };
  const keys = [];
  const DIR_X = [0, 1, 0, -1], DIR_Z = [-1, 0, 1, 0];
  let yaw = 0, cx = sx, cz = sz;
  const walk = (path) => {
    for (let i = 1; i < path.length; i++) {
      const [nx, nz] = path[i];
      let wd = -1;
      for (let j = 0; j < 4; j++) if (DIR_X[j] === nx - cx && DIR_Z[j] === nz - cz) wd = j;
      if (wd < 0) continue;
      let d = (wd - yaw + 4) % 4;
      while (d !== 0) { if (d === 3) { keys.push("ArrowLeft,"); yaw = (yaw + 3) % 4; d = 0; } else { keys.push("ArrowRight,"); yaw = (yaw + 1) % 4; d--; } }
      keys.push("w,");
      cx = nx; cz = nz;
    }
  };
  for (let t = 0; t < 2; t++) {
    const r = bfs(cx, cz, (x, z) => grid[z][x] === "?");
    if (!r) break;
    const [tx, tz, dist, prev] = r;
    const path = [];
    let cur = [tx, tz];
    while (cur) { path.unshift(cur); const k = cur[0] + "," + cur[1]; if (k === cx + "," + cz) break; cur = prev.get(k) || null; }
    walk(path);
    grid[tz][tx] = ".";
  }
  keys.push("q,");
  plan.keys.push(...keys);
  plan.done = true;
  clearInterval(mapWait);
}, 200);
await Promise.race([done, new Promise((r) => setTimeout(r, 60000))]);
const claims = gameOut.filter((s) => String(s).includes("TREASURE FOUND")).length;
const gameDone = gameOut.filter((s) => String(s).includes("GAME DONE")).length;
const ended = gameOut.filter((s) => /GAME OVER|Quit at level/.test(String(s))).length;
let ok = claims >= 2 && gameDone >= 1 && !runError;
console.log(`CLAIMS=${claims} GAME_DONE=${gameDone} ENDED_MSG=${ended} RUNERR=${runError ? (runError.message || "").slice(0, 80) : "none"} WALLMS=${Date.now() - T0}`);
console.log(ok ? "PASS: two treasures claimed, the game continues and finishes cleanly" : "FAIL: the game died at/after the claim");
process.exit(ok ? 0 : 1);
