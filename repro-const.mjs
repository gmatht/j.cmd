import { readFileSync } from "fs";
import { fs } from "/root/src/sh2runtime/src/fs/index.js";
import { bashToJS } from "/root/src/sh2runtime/src/bash2js.js";
import { createSh2Runtime } from "/root/src/sh2runtime/src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3");
const { js } = await bashToJS(fs, src);
// drive a broad gameplay sequence: move, turn, shoot, mine
const SEQ = ["", "w,", "", "d,", "a,", "s,", "ArrowLeft,", "ArrowRight,", "w,", "space,", "space,", "w,", "w,", "a,", "d,", "space,", "s,", "w,", "q,"];
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
  console.log(String(e && e.stack || e).split("\n").slice(0,6).join("\n"));
}
console.log(stdout.join("").split("\n").filter(l => /^#stats|TREASURE|mined|MIME|GAME|LEVEL/.test(l)).slice(-8).join("\n"));
