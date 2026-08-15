// ─── __esc-menu-test.mjs — Esc opens the settings menu mid-game ────
// Drives the game, presses Esc (pause), toggles CRT off in the menu,
// closes with Esc, and verifies the fragment shader was re-emitted live
// and the game resumed.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { execFileSync } from "node:child_process";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((0)); headless=0 ;;");
const { js } = await bashToJS(fs, src);
// move a bit, Esc → menu, s s s (→ CRT), a (off), Esc close, then quit
const KEYS = ["Escape,", "w,", "w,", "Escape,", "s,", "s,", "s,", "d,", "Escape,", "q,"];
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
const frag = await fs.read("/dev/webgl/shader/fragment");

check("CRT effect applied after the live menu toggle", frag.includes("mod(gl_FragCoord.y, 6.0)"));
const log = await fs.read("/dev/webgl/log");
const draws = (log.match(/\[call\] draw /g) || []).length;
check("game resumed and rendered after closing the menu", draws > 40, "draws=" + draws);
check("menu summary printed (live settings applied)", stdout.join("").includes("settings: camera shift"));
if (fails) { console.log("\nESC-MENU: FAIL"); process.exit(1); }
console.log("\nESC-MENU: PASS");
