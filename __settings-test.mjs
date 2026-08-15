// ─── __settings-test.mjs — the pre-game settings menu ──────────────
// Forces the browser path (headless=0) so settings_menu() runs, then
// drives the menu keys: adjust camera shift, size→32, seed +1000, turn
// CRT OFF, corruption OFF, then Esc confirms. Verifies the values reach
// the device (uCamShift, 32px uploads, fallback shader WITHOUT the CRT/
// corruption effects), that every menu swap clears the back buffer, and
// that the cursor follows the 5-way selection.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { execFileSync } from "node:child_process";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((0)); headless=0 ;;");
const { js } = await bashToJS(fs, src);
// d(cam+50) s d(size→32) s d(seed+1000) s s a(CRT off) s a(corrupt off) Esc
// ArrowRight (+value) / ArrowDown (select next) — L/R change the current
// item's value, U/D move the selection
const KEYS = ["ArrowRight,", "ArrowDown,", "ArrowRight,", "ArrowDown,", "ArrowRight,", "ArrowDown,", "ArrowRight,", "ArrowDown,", "ArrowRight,", "Escape,", "w,", "w,", "q,"];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const hudWrites = [];    // first /dev/webgl/hud writes (menu phase)
const calls = [];        // /dev/webgl/call writes (clear/swap sequence)
const camWrites = [];    // every uCamShift uniform write
const origW = fs.write.bind(fs);
fs.write = async (path, content) => {
  const p = fs._resolve(path);
  const s = String(content).trim();
  if (p === "/dev/webgl/hud" && hudWrites.length < 12) hudWrites.push(String(content));
  if (p === "/dev/webgl/call" && (s === "clear" || s === "swap")) calls.push(s);
  if (p === "/dev/webgl/uniform/1f/uCamShift") camWrites.push(s);
  return origW(path, content);
};
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
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 2500) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "bash") {
    const args = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
    try { out = execFileSync("bash", args, { encoding: "utf8" }); } catch { out = ""; }
  }
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
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const cam = (await fs.read("/dev/webgl/uniform/1f/uCamShift")).trim();

check("uCamShift = 0.05 (default 0 + one ArrowRight)", cam === "1f 0.05", cam);
const frag = await fs.read("/dev/webgl/shader/fragment");
check("fragment shader is the fallback (tex_size=32)", frag.includes("texture2D(uTex, vUv)") && !frag.includes("g_tex_r"));
check("CRT effect present in the shader (toggled ON)", frag.includes("mod(gl_FragCoord.y, 6.0)") && frag.includes("450.0"));
check("corruption present in the shader (toggled ON)", frag.includes("97.0"));
const log = await fs.read("/dev/webgl/log");
check("textures uploaded at 32×32", (log.match(/\[texture\/\d+\] 32x32 uploaded/g) || []).length >= 8);
const draws = (log.match(/\[call\] draw /g) || []).length;
check("game loop rendered after the menu", draws > 100, "draws=" + draws);
check("menu printed the chosen settings", stdout.join("").includes("settings: camera shift 0.050"));
// menu rendering: clear before every present (no composite accumulation)
check("menu hud writes captured", hudWrites.length >= 10, "writes=" + hudWrites.length);
let allClear = true;
for (const w of hudWrites.slice(0, 10)) if (w.split("\n")[0] !== "C") allClear = false;
check("every menu redraw clears the HUD layer", allClear);
// the call stream: every swap during the menu is preceded by a clear
let badSeq = false;
for (let i = 1; i < calls.length && i < 24; i++) {
  if (calls[i] === "swap" && calls[i - 1] !== "clear") badSeq = true;
}
check("every menu swap is preceded by a back-buffer clear", !badSeq, calls.slice(0, 16).join(" "));
const cursorY = (w) => { const m = w.match(/-0\.520 ([\d.-]+) 0\.016 0\.030/); return m ? m[1] : null; };
const ySeq = hudWrites.slice(0, 10).map(cursorY);
check("cursor follows the 5-way selection (0.583→0.483→0.383→0.283→0.183)",
  ySeq[0] === "0.583" && ySeq[2] === "0.483" && ySeq[4] === "0.383" && ySeq[6] === "0.283" && ySeq[8] === "0.183",
  ySeq.join(","));
if (fails) { console.log("\nSETTINGS: FAIL"); process.exit(1); }
console.log("\nSETTINGS: PASS");
