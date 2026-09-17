import { readFileSync } from "fs";
import { fs } from "/root/src/sh2runtime/src/fs/index.js";
import { bashToJS } from "/root/src/sh2runtime/src/bash2js.js";
import { createSh2Runtime } from "/root/src/sh2runtime/src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
// force the BROWSER path: the settings menu runs
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((0)); headless=0 ;;");
src = src.replace("if [ \"$headless\" -eq 0 ]; then\n    settings_menu\n    if [ \"$quit\" -eq 1 ]; then", "if [ 1 -eq 0 ]; then\n    settings_menu\n    if [ \"$quit\" -eq 1 ]; then");
const { js } = await bashToJS(fs, src);
// menu keys: D (change), then SPACE to start, then gameplay q
const SEQ = ["d,", "d,", "d,", "d,", "space,", "w,", "space,", "q,"];
let keyFrame = 0;
const stdout = [];
const shellExec = async (cmdline, stdin) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const m = rest.match(/^(\S+)\s*>\s*(\S+)/);
    if (m) { const srcP = fs._resolve(m[1]), dst = fs._resolve(m[2]);
      if (srcP === "/dev/webgl/key") { out = (keyFrame < SEQ.length ? SEQ[keyFrame] : "") + "\n"; keyFrame++; }
      else { try { const c = await fs.read(srcP); await fs.write(dst, c); out = ""; } catch (e) { out = ""; } }
    } else { const p = fs._resolve(rest.split(/\s+/)[0]);
      if (p === "/dev/webgl/key") { out = (keyFrame < SEQ.length ? SEQ[keyFrame] : "") + "\n"; keyFrame++; }
      else { try { out = await fs.read(p); } catch (e) { out = ""; } } }
  }
  else if (cmd === "sleep") {}
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const errOut = { write: (s) => stdout.push("[err] " + s) };
const ow = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { stdout.push(String(s)); return ow(s, ...rest); };
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: errOut, args: [], argv0: "bash" });
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") { const k = keyFrame < SEQ.length ? SEQ[keyFrame] : ""; keyFrame++; return k; }
  return origSh2ReadFile(p, enc);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2); }
catch (e) {
  console.log("⚠ THREW:");
  console.log(String(e && e.stack || e).split("\n").slice(0,8).join("\n"));
} 
const text = stdout.join("");
console.log(text.split("\n").filter(l => /SETTINGS|MENU|Quit|GAME|SPACE|server|shift|CAM|SOUND|START/.test(l)).slice(-10).join("\n"));
