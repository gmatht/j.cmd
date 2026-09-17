// --sounds bash + shoot: cache_sound stages + generates the TSV via the
// HOST bash, play_sound cats it into /dev/audio/samples. PASS = the
// audio device receives a parsed payload and no script text leaks to
// the terminal.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace(/precache_sounds &/g, "true"); // assert the IN-GAME plays drive the generators
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((1)); headless=0 ;;"); // force sound on (CLI has no Web Audio)
console.log("REPLACED precache:", src.includes("precache_sounds &"), "-> after replace:", src.includes("true
  if [ \"$SOUND_MODE\""));
const { js } = await bashToJS(fs, src);
const stdout = [];
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
    if (m) { const vert = !!m[1];
      try { const s2 = String(await fs.read(fs._resolve(m[2])));
        const { getOtranspilerl } = await import("./src/otranspilerl.js");
        const lib = await getOtranspilerl();
        out = vert ? lib.glslv(s2) : lib.glsl(s2);
      } catch { out = ""; } }
  }
  else if (cmd === "bash") {
    const parts = rest.split(/\s+/).filter(Boolean);
    const script = parts.shift();
    try {
      const p = fs._resolve(script);
      const txt = String(await fs.read(p));
      const t = "/tmp/.host-snd-" + Math.random().toString(36).slice(2) + ".sh";
      mkdirSync("/tmp", { recursive: true });
      writeFileSync(t, txt);
      out = execFileSync("bash", [t, ...parts], { encoding: "utf8", timeout: 60000 });
      unlinkSync(t);
    } catch (e) { out = ""; console.log("BASH-ERR", e.message.slice(0, 80)); }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => {
  stdout.push(s);
  if (String(s).startsWith("#!/usr/bin/env bash")) console.log("STACK-AT-LEAK:", (new Error().stack || "").split("\n").slice(1, 8).map((l) => l.trim()).join(" ~ "));
} };
let webglDev = null, audioDev = null;
for (const m of Object.values(fs.mounts || {})) {
  const b = m && m.backend;
  if (b && b._webgl) webglDev = b._webgl;
  if (b && b._audio) audioDev = b._audio;
}
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: ["--sounds", "bash"], argv0: "bash" });
const playCalls = [];
const testCalls = [], redirCalls = [];
const origTest = rt.sh2.test.bind(rt.sh2);
rt.sh2.test = (t) => { testCalls.push(String(t).slice(0, 60)); if (String(t).includes("mimecroft-snd")) {} return origTest(t); };
const origRedir = rt.sh2.redirect.bind(rt.sh2);
rt.sh2.redirect = (...a) => { const tgt = a[1] && a[1][0] && a[1][0].target; if (String(tgt).includes("audio")) redirCalls.push(tgt); return origRedir(...a); };
const wrapFn = (name, fn) => {
  const orig = rt.sh2.functions.get(name);
  rt.sh2.functions.set(name, () => {
    const tag = name + "(pos=" + (rt.sh2.positional || []).join(",") + ")";
    playCalls.push(tag);
    return orig();
  });
};
for (const n of ["play", "play_sound", "cache_sound", "snd_of_note"]) wrapFn(n);
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
const origRead = webglDev.read.bind(webglDev);
let reads = 0;
webglDev.read = async (path) => {
  if (String(path).includes("key")) {
    reads++;
    webglDev._keys = reads === 1 ? ["space,"] : (reads > 90 ? ["q,"] : ["w,"]);
  }
  return origRead(path);
};
webglDev._keys = ["space,"];
let runError = null;
const done = fn(["--sounds", "bash"], fs, { HOME: "/home" }, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2).catch((e) => { runError = e; });
await Promise.race([done, new Promise((r) => setTimeout(r, 150000))]);
const leaked = stdout.filter((s) => String(s).startsWith("#!/usr/bin/env bash") || String(s).includes("sound_main"));
const leakIdx = stdout.findIndex((s) => String(s).startsWith("#!/usr/bin/env bash"));
console.log("FIRST-10", JSON.stringify(stdout.slice(0, 10).map((s) => String(s).slice(0, 50))));
console.log("LEAK-CONTEXT", JSON.stringify(stdout.slice(Math.max(0, leakIdx - 2), leakIdx + 1).map((s) => String(s).slice(0, 60))));
const samplesWrites = [];
const sndReads = [];
const noteWrites = [];
const origFsW = fs.write.bind(fs);
fs.write = async (path, content) => {
  if (fs._resolve(path) === "/dev/audio/samples") {
    samplesWrites.push(String(content).slice(0, 40));
    try { await origFsW(path, content); } catch {}
    return;
  }
  if (fs._resolve(path) === "/dev/audio/note") noteWrites.push(String(content).trim());
  return origFsW(path, content);
};
const origFsR = fs.read.bind(fs);
fs.read = async (path, ...rest) => {
  const p = fs._resolve(path);
  if (p.startsWith("/tmp/mimecroft-snd-")) sndReads.push(p);
  return origFsR(path, ...rest);
};
await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
await new Promise((r) => setTimeout(r, 100));
console.log("RESULT", JSON.stringify({
  reads, runError: runError ? runError.message : null,
  leakedScripts: leaked.length, leakedSample: String(leaked[0] || "").slice(0, 30),
  samplesWrites: samplesWrites.length, firstSample: String(samplesWrites[0] || "").slice(0, 40),
  sndReads: sndReads.slice(0, 4),
  noteWrites: noteWrites.slice(0, 8),
  playCalls: playCalls.slice(0, 14), testCount: testCalls.length, sndTests: testCalls.filter((t) => String(t).includes("snd-") || String(t).includes("sound-") || String(t).includes("-f /tmp")).slice(0, 10), redirCalls: redirCalls.slice(0, 4),
  cacheFiles: ["/tmp/mimecroft-snd-hit.tsv", "/tmp/mimecroft-snd-hit-stone.tsv", "/tmp/mimecroft-snd-thud.tsv"].map((p) => { try { fs.statSync(p); return true; } catch { return false; } }),
}));
const pass = !runError && !leaked.length && samplesWrites.length >= 1 && samplesWrites[0].startsWith("#sound");
console.log(pass ? "PASS — sound reached the device, no script leak" : "FAIL");
process.exit(pass ? 0 : 1);
