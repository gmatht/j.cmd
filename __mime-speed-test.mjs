// ─── __mime-speed-test.mjs — mime_speed is SIGNED ─────────────────
// Positive = the MIMEs hunt the player; negative = they RUN AWAY;
// 0 = frozen. This test runs the REAL game twice with the same idle
// key stream (claim the fixed treasure → two MIMEs spawn → stand
// still while they act):
//
//   control  mime_speed=+15  the MIMEs converge, reach the player,
//                            deal damage (hp drops) and die on contact
//   flee     mime_speed=-15  the MIMEs flee — hp stays at max and the
//                            mime count is untouched
//
// The hp/frame/mime_count come from the runtime store after the run.
//
//   node __mime-speed-test.mjs   → "mime speed sign test: PASS"
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

async function play(speed) {
  let src = readFileSync("examples/mimecroft.sh", "utf8");
  src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
  src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3"); // claim 1, keep playing
  src = src.replace("mime_speed=15", "mime_speed=" + speed);
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
      if (p === "/dev/webgl/key") { out = (keyFrame === 0 ? "space," : "") + "\n"; keyFrame++; }
      else { try { out = await fs.read(p); } catch (e) { out = ""; } }
    }
    else if (cmd === "sleep") { sleepCount++; if (sleepCount % 25 === 0) process.stderr.write("s=" + sleepCount + " @" + Date.now() + "\n"); if (sleepCount > 150) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
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
      const k = keyFrame === 0 ? "space," : "";
      keyFrame++;
      return k;
    }
    return origSh2ReadFile(p, enc);
  };
  const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
  try { await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2); }
  catch (e) { if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); } }
  const num = (v) => { try { return Number(rt.sh2.getVar(v)); } catch { return NaN; } };
  return {
    hp: num("hp"),
    frame: num("frame"),
    mimes: num("mime_count"),
    score: num("score"),
    text: stdout.join(""),
  };
}

const hunt = await play(15);
console.log("── run 2: flee −15");
const flee = await play(-15);
console.log("── run 3: frozen 0");
const frozen = await play(0);
console.log("hunt(+15):   hp=" + hunt.hp + " mimes=" + hunt.mimes + " frame=" + hunt.frame + " score=" + hunt.score);
console.log("flee(-15):   hp=" + flee.hp + " mimes=" + flee.mimes + " frame=" + flee.frame + " score=" + flee.score);
console.log("frozen(0):   hp=" + frozen.hp + " mimes=" + frozen.mimes + " frame=" + frozen.frame + " score=" + frozen.score);
console.log("(text checks: flee saw the treasure banner —", flee.text.includes("TREASURE FOUND:"), ")");

const ok =
  flee.hp === 10 && flee.mimes === 2 &&          // fleeing MIMEs never touch you
  hunt.hp < 10 && hunt.mimes < 2 &&              // control: they converge, hurt, die
  frozen.hp === 10 && frozen.mimes === 2 &&      // speed 0 = frozen in place
  flee.text.includes("TREASURE FOUND:") &&
  hunt.text.includes("TREASURE FOUND:");
console.log("mime speed sign test:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
