// turn right (yaw 0→1), then move — should move +x (camera x increases)
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const KEYS = ["ArrowRight,", "w,", "w,", "w,", "q,"];
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 500) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
const cam = (await fs.read("/dev/webgl/uniform/3f/uCamPos")).trim();
const yaw = (await fs.read("/dev/webgl/uniform/1f/uCamYaw")).trim();
console.log("final uCamPos:", cam, "(spawn 2 0 2 — after right-turn + 3 w's, expect x > 2)");
console.log("final uCamYaw:", yaw, "(expect 1f 90 after ArrowRight)");
console.log("move-dir:", cam.split(/\s+/)[1] !== "2" && Number(cam.split(/\s+/)[1]) > 2 ? "PASS (moved +x)" : "FAIL (not +x)", "| yaw:", yaw === "1f 90" ? "PASS" : "FAIL");
