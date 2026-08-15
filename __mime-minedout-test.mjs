// ─── __mime-minedout-test.mjs — the MINED OUT popup + level transition ──
// Shooting an artifact SHATTERS it without claiming it (licence strike,
// -50). If the player destroys a treasure this way, the board can't be
// completed: the game must show the MINED OUT popup (terminal + canvas)
// and PAUSE until dismissed, then transition to the next level with the
// licence penalty — not just cut abruptly to the new maze.
//
// Setup: TREASURE_TOTAL=3 with ONE treasure at (2,1,1); press SPACE to
// shatter it (1 hit, hardness 1). The board is then mined out with
// found_count=0 → MINED OUT popup (SPACE dismisses) → level 2 begins →
// q quits.
//
//   node __mime-minedout-test.mjs   → "mined-out popup test: PASS"
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3");
src = src.replace(
  "place_treasures() {\n  pt_t=0\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do",
  "place_treasures() {\n  pt_t=0\n  set_cell 2 1 1 $TREASURE\n  set_treasure_pos 0 2 1\n  pt_t=$((pt_t + 3))\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do"
);
const { js } = await bashToJS(fs, src);
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
    if (p === "/dev/webgl/key") {
      // frame 0: SPACE shatters the treasure → mined out; frame 1: SPACE
      // dismisses the MINED OUT popup; then q quits level 2
      const k = keyFrame === 0 ? "space," : keyFrame === 1 ? "space," : "q,";
      out = k + "\n"; keyFrame++;
    }
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
  if (String(p) === "/dev/webgl/key") {
    const k = keyFrame === 0 ? "space," : keyFrame === 1 ? "space," : "q,";
    keyFrame++;
    return k;
  }
  return origSh2ReadFile(p, enc);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2); }
catch (e) { console.log("RUN ERROR:", e.message); process.exit(1); }
const text = stdout.join("");
const ok =
  text.includes("You SHOT an artifact") &&      // the shatter message
  text.includes("MINED OUT — an artifact was SHATTERED!") &&   // the popup
  text.includes("press SPACE for level 2") &&   // the popup's prompt
  text.includes("LEVEL 2 begins") &&             // the next level began (the mined-out banner)
  text.includes("GAME DONE") &&
  !text.includes("TREASURE FOUND") &&            // nothing was claimed
  !text.includes("VICTORY");
console.log("mined-out popup test:", ok ? "PASS" : "FAIL");
console.log(text.split("\n").filter((l) => /MINED OUT|SHOT|LEVEL 2|GAME DONE|TREASURE FOUND/.test(l)).slice(0, 10).join("\n"));
process.exit(ok ? 0 : 1);
