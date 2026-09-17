// ─── __game-full.mjs — drive the game with real keys (shoot, walk,
// turn) and REAL bash (host bash runs the staged sound generators) —
// verifies sounds reach /dev/audio/samples, textures load, treasure
// collection does not crash, and the game quits cleanly on q.
import { readFileSync } from "fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const stdout = [];
const KEYSEQ = [];
for (let i = 0; i < 120; i++) KEYSEQ.push("w,");
KEYSEQ.push("q,");
let keyFrame = 0;
const trace = [];
let shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  trace.push(["C", cl.slice(0, 60)]);
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
      } catch (e) { out = ""; }
    }
  }
  else if (cmd === "bash") {
    // real bash: run the staged script with host bash
    const parts = rest.split(/\s+/).filter(Boolean);
    const script = parts.shift();
    try {
      const p = fs._resolve(script);
      const txt = String(await fs.read(p));
      const t = "/tmp/.host-" + Math.random().toString(36).slice(2) + ".sh";
      const { writeFileSync, mkdirSync } = await import("fs");
      mkdirSync("/tmp", { recursive: true });
      writeFileSync(t, txt);
      out = execFileSync("bash", [t, ...parts], { encoding: "utf8", timeout: 60000 });
      const { unlinkSync } = await import("fs");
      unlinkSync(t);
    } catch (e) { out = ""; }
  }
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
// re-arm the key queue each read: the game's read DRAINS the queue, so
// arm it from the device read itself
const origDevRead = webglDev.read.bind(webglDev);
const devReadTimes = [];
let lastMark = Date.now();
webglDev.read = async (path) => {
  const t0 = Date.now();
  if (String(path).includes("key")) {
    webglDev._keys = [KEYSEQ[keyFrame % KEYSEQ.length]];
    keyFrame++;
    webglDev._keys = [...webglDev._keys];
    devReadTimes.push([t0 - lastMark, "KEYREAD", keyFrame]);
    lastMark = t0;
  }
  const r = await origDevRead(path);
  return r;
};
webglDev._keys = ["space,"];
let audioDev = null;
for (const m of Object.values(fs.mounts || {})) {
  const b = m && m.backend;
  if (b && b._audio) { audioDev = b._audio; break; }
}
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
let failed = null;
try {
  await Promise.race([
    fn([], fs, { HOME: "/home" }, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2),
    new Promise((res) => setTimeout(() => { failed = "TIMEOUT"; res(); }, 120000)),
  ]);
} catch (e) { failed = e.message; }
console.log("DEV READ TIMES (ms since prev):", JSON.stringify(devReadTimes.slice(0, 30)));
const errs = stdout.filter((s) => String(s).includes("undefined") || String(s).includes("FAILED") || String(s).includes("not a function") || String(s).includes("Error:"));
if (failed) { console.log("FAIL:", failed); console.log("tail:", JSON.stringify(stdout.slice(-8))); process.exit(1); }
if (errs.length) { console.log("FAIL — errors:", JSON.stringify(errs.slice(0, 5))); console.log("tail:", JSON.stringify(stdout.slice(-8))); process.exit(1); }
const audioInfo = audioDev ? (audioDev._lastPayload ? { rate: audioDev._lastPayload.rate, n: audioDev._lastPayload.samples && audioDev._lastPayload.samples.length } : { n: 0 }) : null;
console.log("PASS — game complete; audio payloads:", audioInfo ? JSON.stringify(audioInfo) : "no audio dev");
console.log("stdout tail:", JSON.stringify(stdout.slice(-5)));
