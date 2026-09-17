// ─── Regression check: ALL RECOVERED path ─────────────────────────
// TREASURE_TOTAL=3 but only TWO treasures placed (a short board). The
// player walks into both → the map has no treasures left and every
// placed artifact was recovered → the ending must be the "ALL
// RECOVERED" variant, not "MINED OUT"/"VICTORY".
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3");
src = src.replace(
  "place_treasures() {\n  pt_t=0\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do",
  "place_treasures() {\n  pt_t=0\n  set_cell 2 1 1 $TREASURE\n  set_treasure_pos 0 2 1\n  set_cell 1 1 1 $TREASURE\n  set_treasure_pos 1 1 1\n  pt_t=$((pt_t + 3))\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do"
);
const { js } = await bashToJS(fs, src);
let keyFrame = 0;
const KEYS = ["w,", "ArrowLeft,", "w,", "q,"];
const stdout = [];
const shellExec = async (cmdline, stdin) => {
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
const found = (text.match(/TREASURE FOUND:/g) || []).length;
const ok =
  found === 2 &&
  text.includes("ALL RECOVERED") &&
  !text.includes("MINED OUT") &&
  !text.includes("VICTORY") &&
  !text.includes("LICENCE REVOKED") &&
  text.includes("GAME DONE");
console.log("all-recovered path:", ok ? "PASS" : "FAIL", "(treasures found:", found + ")");
console.log(text.split("\n").filter((l) => /ALL RECOVERED|MINED OUT|VICTORY|TREASURE FOUND|GAME DONE/.test(l)).slice(-6).join("\n"));
process.exit(ok ? 0 : 1);
