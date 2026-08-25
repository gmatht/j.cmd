import { readFileSync } from "fs";
import { fs } from "/root/src/sh2runtime/src/fs/index.js";
import { bashToJS } from "/root/src/sh2runtime/src/bash2js.js";
import { createSh2Runtime } from "/root/src/sh2runtime/src/sh2runtime.js";
let src = readFileSync("/root/src/sh2runtime/www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1");
let js;
try { ({ js } = await bashToJS(fs, src)); } catch (e) { console.log("TRANSPILE FAILED:", e.message); process.exit(1); }
const KEY_SCRIPT = Array(10).fill("w,").concat(["ArrowRight,","w,","w,","w,","ArrowLeft,","space,","q,"]);
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const hudPayloads = [];
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
  else if (cmd === "bash" || cmd === "sh2glsl" || cmd === "true") { out = ""; }
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const err = { write: () => {} };
const rt = createSh2Runtime({ fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") { const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,"; keyFrame++; return k; }
  return origSh2ReadFile(p, enc);
};
const origWrite = rt.sh2.fs.writeFile.bind(rt.sh2.fs);
rt.sh2.fs.writeFile = async (p, data, enc) => {
  if (String(p) === "/dev/webgl/hud") hudPayloads.push(String(data));
  return origWrite(p, data, enc);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, err, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
// fps digits: white (0.95 0.95 0.95) rects in x 0.15..0.48 band (W at ~0.176, A at ~0.368), y 0.73..0.85
function fpsKey(p) {
  const rects = p.split("\n").filter((l) => {
    const c = l.split(/\s+/);
    return c.length >= 7 && c[4] === "0.95" && c[5] === "0.95" && c[6] === "0.95" &&
      parseFloat(c[0]) > 0.15 && parseFloat(c[0]) < 0.5;
  }).map((l) => l.split(/\s+/).slice(0, 2).join("/")).sort().join(",");
  return rects;
}
let prev = null;
for (let i = 0; i < hudPayloads.length; i++) {
  const k = fpsKey(hudPayloads[i]);
  if (k !== prev) {
    console.log("payload", i, "fps-white-pixels len", k.length, k.slice(0, 60) || "(none)");
    prev = k;
  }
}
