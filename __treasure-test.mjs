// ─── __treasure-test.mjs — drive the game to a treasure by wandering,
// and verify the claim does not crash. PASS = "TREASURE FOUND" printed,
// found_count incremented, game still running, no errors.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const stdout = [];
const gameOut = [];
const origPw = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { gameOut.push(String(s)); return origPw(s, ...rest); };
const plan = [];
// the map prints ONCE at startup (16 rows of 16 chars: @ player,
// . AIR, ? treasure, # wall) — parse it from stdout and BFS a path
const planMap = { done: false, keys: [] };
let shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") { try { out = await fs.read(fs._resolve(rest.split(/\s+/)[0])); } catch { out = ""; } }
  else if (cmd === "sleep") { await new Promise(r => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") {
    const m = cl.match(/^sh2glsl\s+(--vertex\s+)?(\S+)/);
    if (m) {
      const vert = !!m[1];
      try {
        const srcTxt = String(await fs.read(fs._resolve(m[2])));
        const { getOtranspilerl } = await import("./src/otranspilerl.js");
        const lib = await getOtranspilerl();
        out = vert ? lib.glslv(srcTxt) : lib.glsl(srcTxt);
      } catch { out = ""; }
    }
  }
  else if (cmd === "bash") { out = "  fake-tex-tsv\n"; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
let webglDev = null;
for (const m of Object.values(fs.mounts || {})) {
  const b = m && m.backend;
  if (b && b._webgl) { webglDev = b._webgl; break; }
}
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
let runError = null;
const done = fn([], fs, { HOME: "/home" }, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2)
  .catch((e) => { runError = e; });
const origRead = webglDev.read.bind(webglDev);
const feedNext = () => {
  if (!planMap.done) { webglDev._keys = []; return; } // idle until the BFS plans
  webglDev._keys = planMap.keys.length ? [planMap.keys.shift()] : ["q,"];
};
webglDev.read = async (path) => {
  if (String(path).includes("key")) { feedNext(); webglDev._keys = [...webglDev._keys]; }
  return origRead(path);
};
webglDev._keys = []; // idle until the BFS plans the path
// parse the map + BFS once it prints
const mapWait = setInterval(() => {
  if (planMap.done) return;
  const mi = gameOut.findIndex((s) => String(s).includes("MIMEcroft  artifacts"));
  if (mi < 0) return;
  const rows = [];
  for (let r = mi + 1; r < mi + 17; r++) {
    const t = String(gameOut[r] || "").replace(/^\s*/, "").trim();
    if (/^[.@?#]{16}$/.test(t)) rows.push(t);
  }
  if (rows.length < 16) { console.log("BFS-DBG rows=" + rows.length + " mi=" + mi + " printable=" + stdout.filter((s) => /^[.@?#]{16}$/.test(String(s).trim())).length); return; }
  let sx = 0, sz = 0, tx = 0, tz = 0;
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const c = rows[z][x];
    if (c === "@") { sx = x; sz = z; }
    if (c === "?") { tx = x; tz = z; }
  }
  const open = (x, z) => { const c = rows[z] && rows[z][x]; return c === "." || c === "@" || c === "?"; };
  const dist = new Map(), prev = new Map();
  const q = [[sx, sz]]; dist.set(sx + "," + sz, 0);
  let target = null;
  while (q.length) {
    const [x, z] = q.shift();
    if (x === tx && z === tz) { target = [x, z]; break; }
    if (dist.get(x + "," + z) > 60) break;
    for (const [dx, dz] of [[0,1],[1,0],[0,-1],[-1,0]]) {
      const nx = x + dx, nz = z + dz, k = nx + "," + nz;
      if (nx < 0 || nz < 0 || nx > 15 || nz > 15) continue;
      if (dist.has(k) || !open(nx, nz)) continue;
      dist.set(k, dist.get(x + "," + z) + 1); prev.set(k, [x, z]); q.push([nx, nz]);
    }
  }
  if (!target) { console.log("BFS: no path", JSON.stringify({ p: [sx, sz], t: [tx, tz] })); planMap.done = true; return; }
  const path = [];
  let cur = target;
  while (cur) { path.unshift(cur); const k = cur[0] + "," + cur[1]; if (k === sx + "," + sz) break; cur = prev.get(k) || null; }
  const DIR_X = [0, 1, 0, -1], DIR_Z = [-1, 0, 1, 0];
  let yaw = 0;
  const keys = [];
  for (let i = 1; i < path.length; i++) {
    const [cx, cz] = path[i - 1], [nx, nz] = path[i];
    let wd = -1;
    for (let j = 0; j < 4; j++) if (DIR_X[j] === nx - cx && DIR_Z[j] === nz - cz) wd = j;
    if (wd < 0) continue;
    let d = (wd - yaw + 4) % 4;
    while (d !== 0) {
      if (d === 3) { keys.push("ArrowLeft,"); yaw = (yaw + 3) % 4; d = 0; }
      else { keys.push("ArrowRight,"); yaw = (yaw + 1) % 4; d--; }
    }
    keys.push("w,");
  }
  keys.push("ArrowRight,"); // face the treasure cell (the label)
  planMap.keys.push(...keys, "q,");
  planMap.done = true;
  console.log("BFS path:", JSON.stringify({ sx, sz, tx, tz, len: path.length, keys: keys.length }));
  clearInterval(mapWait);
}, 200);
await Promise.race([done, new Promise((r) => setTimeout(r, 150000))]);
const errs = stdout.filter((s) => /undefined|not a function|Error:|FAILED/.test(String(s)));
const foundMsg = gameOut.some((s) => String(s).includes("TREASURE FOUND"));
const claimed = foundMsg && gameOut.some((s) => String(s).includes("artifacts recovered"));
const crashed = runError || errs.some((s) => /not a function|Error:/.test(String(s)));
console.log("RESULT", JSON.stringify({ foundMsg, claimed, errs: errs.slice(0, 3), runError: runError ? runError.message : null }));
console.log(claimed && !crashed ? "PASS — treasure claimed, no crash" : "FAIL");
process.exit(claimed && !crashed ? 0 : 1);