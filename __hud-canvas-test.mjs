// canvas-HUD variant: force headless=0 so draw_hud_canvas runs against
// the NullGL device — verify the overlay draws, floor/ceiling, and that
// the fmt/draw_text/glyph logic executes without error.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("*headless*) sound=$((0)); headless=$((1)) ;;", "*headless*) sound=$((0)); headless=$((0)) ;;");
const { js } = await bashToJS(fs, src);
const KEYS = ["w,", "ArrowRight,", "w,", "space,", "w,", "w,", "q,"];
let keyFrame = 0, sleepCount = 0;
const tStart = Date.now();
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 2000 || (Date.now() - tStart) > 60000) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
// wall-clock budget: the A1 path emits sleeps as NATIVE setTimeouts (no
// shellExec), so the sleep-count stop never fires — race the run against
// a 60s budget regardless of how the sleeps were lowered.
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try {
  await Promise.race([
    fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2),
    new Promise((_, rej) => setTimeout(() => rej(new Error("test-stop")), 60000)),
  ]);
}
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
const log = await fs.read("/dev/webgl/log");
const hudLines = (log.match(/\[hud\] \d+ rects/g) || []).map((l) => Number(/(\d+) rects/.exec(l)[1]));
const hudTotal = hudLines.reduce((a, b) => a + b, 0);
const cubeDraws = (log.match(/draw elements triangles count=36/g) || []).length;
const errLines = stdout.filter((l) => l.includes("[err]") || /command not found/.test(l)).length;
const triLines = (log.match(/\[hud\] \d+ rects \d+ tris/g) || []).map((l) => Number(/(\d+) tris/.exec(l)[1])).reduce((a, b) => a + b, 0);
console.log("hud (batched overlay) writes:", hudLines.length, "| rects total:", hudTotal, "| rects/frame:", Math.round(hudTotal / Math.max(1, hudLines.length)), "| player triangles:", triLines);
console.log("cube draws (world + floor/ceiling):", cubeDraws);
console.log("errors in output:", errLines);
const ok = hudLines.length >= 1 && hudTotal > 200 && cubeDraws > 100 && errLines === 0;
console.log(ok ? "CANVAS-HUD: PASS" : "CANVAS-HUD: FAIL");
process.exit(ok ? 0 : 1);
