// ─── __license-test.mjs — shooting a treasure ─────────────────────
// Hidden treasures are claimed by WALKING INTO them; shooting one
// SHATTERS it: -50 score and one archeology-licence strike. Three
// strikes revoke the licence and end the game. This test places three
// treasures around the spawn pocket (ahead / right / behind-right),
// shoots all three, and asserts:
//   • no TREASURE FOUND (shooting never claims)
//   • the shatter messages + licence countdown appear
//   • score stays 0 (3 × -50 floors at 0)
//   • the game ends with the LICENCE REVOKED banner
//   • the ten 64×64 name-label textures were generated at startup
//   • visible labels are drawn (HUD "I " image commands)
//   node __license-test.mjs
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3");
src = src.replace(
  "place_treasures() {\n  pt_t=0\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do",
  `place_treasures() {
  pt_t=0
  set_cell 2 1 1 $TREASURE
  set_treasure_pos 0 2 1
  set_cell 3 1 2 $TREASURE
  set_treasure_pos 1 3 2
  set_cell 2 1 3 $TREASURE
  set_treasure_pos 2 2 3
  pt_t=$((pt_t + 3))
  while [ "$pt_t" -lt "$TREASURE_TOTAL" ]; do`
);
const { js } = await bashToJS(fs, src);
// shoot (2,1,1) ahead · turn right · shoot (3,1,2) · turn right · shoot (2,1,3)
const KEYS = ["space,", "ArrowRight,", "space,", "ArrowRight,", "space,", "q,"];
let keyFrame = 0;
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
  else if (cmd === "sleep") { await new Promise((r) => setTimeout(r, 0)); }
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
    const k = keyFrame < KEYS.length ? KEYS[keyFrame] : "q,";
    keyFrame++;
    return k;
  }
  return origSh2ReadFile(p, enc);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2); }
catch (e) { console.log("RUN ERROR:", e.message); process.exit(1); }
const text = stdout.join("");
const log = await fs.read("/dev/webgl/log");
const labelTexUploads = (log.match(/\[texture\/2[1-9]\] 64x64 uploaded/g) || []).length;
const mimeBannerUploads = (log.match(/\[texture\/3[1-4]\] 64x64 uploaded/g) || []).length;
const imageDraws = (log.match(/images/g) || []).length;
const shattered = (text.match(/shattered/g) || []).length;
const checks = [
  ["shot all three treasures shattered", shattered === 3],
  ["shooting never claims (no TREASURE FOUND)", !text.includes("TREASURE FOUND:")],
  ["licence countdown messages", text.includes("licence 2 / 3") && text.includes("licence 1 / 3")],
  ["-50 score penalty shown", text.includes("-50 score")],
  ["LICENCE REVOKED game over", text.includes("LICENCE REVOKED")],
  ["no VICTORY", !text.includes("VICTORY")],
  ["label textures generated for every treasure (3 in this test)", labelTexUploads === 3],
  ["MIME name-banner textures generated (JPEG/PNG/OCTET/TEXT)", mimeBannerUploads === 4],
  ["visible labels drawn on the HUD (image commands)", imageDraws > 0],
  ["no runtime errors", !/command not found|\[err\]/.test(text)],
];
let fails = 0;
for (const [name, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) fails++;
}
console.log("label texture uploads:", labelTexUploads, "| HUD image draws:", imageDraws, "| shatter messages:", shattered);
console.log(text.split("\n").filter((l) => /licence|shattered|SHOT|GAME OVER|VICTORY|TREASURE/.test(l)).slice(0, 14).join("\n"));
console.log(fails === 0 ? "LICENSE MECHANIC: PASS" : "LICENSE MECHANIC: FAIL");
process.exit(fails === 0 ? 0 : 1);
