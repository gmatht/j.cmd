// ─── Win-path test: TREASURE_TOTAL=1, treasure at (2,1,1) — the cell
// straight ahead of spawn (2,2) facing -z. One W press walks into it
// (hidden treasures are claimed by WALKING IN, not by shooting).
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=1");
// fixed placement at (2,0,1): replace the random placement loop body
src = src.replace(
  "place_treasures() {\n  pt_t=0\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do",
  "place_treasures() {\n  pt_t=0\n  set_cell 2 1 1 $TREASURE\n  set_treasure_pos 0 2 1\n  pt_t=$((pt_t + 1))\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do"
);
const { js } = await bashToJS(fs, src);
let keyFrame = 0, sleepCount = 0;
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
    if (p === "/dev/webgl/key") { out = (keyFrame === 0 ? "w," : "q,") + "\n"; keyFrame++; }
    else { try { out = await fs.read(p); } catch (e) { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 200) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const errOut = { write: (s) => stdout.push("[err] " + s) };
// the current wasm lowers many `echo` calls to native `process.stdout.write`
// (bypassing the runtime's stdout sink) — capture those into the same text
// buffer the assertions scan.
const ow = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { stdout.push(String(s)); return ow(s, ...rest); };
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: errOut, args: [], argv0: "bash" });
// the current wasm lowers `keys=$(cat /dev/webgl/key)` to a DIRECT device
// read (`sh2.fs.readFile("/dev/webgl/key")`) — feed the scripted keys
// through the same bridge the browser's keyboard uses (the shellExec cat
// branch above only serves the old exec form).
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") {
    const k = keyFrame === 0 ? "w," : "q,";
    keyFrame++;
    return k;
  }
  const v = await origSh2ReadFile(p, enc);
  return v;
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
const text = stdout.join("");
const ok =
  text.includes("TREASURE FOUND:") &&
  /artifacts recovered: 1 \/ 1/.test(text) &&
  text.includes("VICTORY") &&
  text.includes("GAME DONE");
console.log("win-path:", ok ? "PASS" : "FAIL");
console.log(text.split("\n").filter((l) => l.includes("TREASURE") || l.includes("VICTORY") || l.includes("GAME DONE") || l.includes("artifacts recovered")).slice(0, 8).join("\n"));
process.exit(ok ? 0 : 1);
