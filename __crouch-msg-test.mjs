import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3");
const { js } = await bashToJS(fs, src);
// face +z, step to (2,3), mine the 2-tall stone wall at (2,4) (2 hits),
// step into the 1-tall passage → crouch
const KEYS = ["ArrowLeft,","ArrowLeft,","w,","space,","space,","w,",
  "ArrowLeft,","ArrowLeft,","w,",
  "ArrowRight,","ArrowRight,","w,",
  "q,"];
let keyFrame = 0;
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else { try { out = await fs.read(p); } catch (e) { out = ""; } }
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
  if (String(p) === "/dev/webgl/key") { const k = keyFrame < KEYS.length ? KEYS[keyFrame] : "q,"; keyFrame++; return k; }
  return origSh2ReadFile(p, enc);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2);
const text = stdout.join("");
const n = (text.match(/Crouching: movement speed reduced/g) || []).length;
console.log("crouch messages printed:", n);
console.log(text.split("\n").filter((l) => /Crouch|mined|MIME sanitised|TREASURE/.test(l)).slice(0, 6).join("\n") || "(no action messages)");
console.log(n === 1 ? "PASS" : "FAIL");
process.exit(n === 1 ? 0 : 1);
