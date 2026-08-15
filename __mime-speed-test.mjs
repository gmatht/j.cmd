// ─── __mime-speed-test.mjs — mime_speed is SIGNED ─────────────────
// Positive = the MIMEs hunt the player; negative = they RUN AWAY;
// 0 = frozen. This test runs the REAL game three times with the same
// key stream (walk into the fixed treasure at frame 0 — hidden
// treasures are claimed by WALKING IN, not shooting — → three initial
// MIMEs + two spawned act; idle ~50 frames; then q to quit):
//
//   control  mime_speed=+2   the MIMEs converge, reach the player
//                            (contact = "MIME sanitised" + score),
//                            deal damage and die on contact
//   flee     mime_speed=-2   the MIMEs move (draws happen) but NEVER
//                            reach the player — no contact, score 100
//   frozen   mime_speed=0    the MIMEs never step — no movement draws//
// Observations: stdout text (authoritative — hp/score are plain JS
// lets the store never sees), the live mime_count store var, and the
// /dev/webgl draw-count delta per run (mime movement renders).
//
//   node __mime-speed-test.mjs   → "mime speed sign test: PASS"
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

async function play(speed) {
  let src = readFileSync("www/bin/mimecroft.sh", "utf8");
// the radar is OFF by default now — force it on (this test asserts the radar HUD / movement draws)
src = src.replace("MINIMAP_MODE=0         # the on-screen radar: 0 = off (default), 1 = full, 2 = 50% transparent", "MINIMAP_MODE=1         # the on-screen radar: 0 = off (default), 1 = full, 2 = 50% transparent");
  src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
  src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3"); // claim 1, keep playing
  src = src.replace("mime_speed=15", "mime_speed=" + speed);
  // fixed placement — ALL treasures present (a mined-out board would
  // trigger the "At least you didn't lose" ending and end the game
  // before the mimes get to act): replace the random placement loop
  src = src.replace(
    "place_treasures() {\n  pt_t=0\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do",
    "place_treasures() {\n  pt_t=0\n  set_cell 2 1 1 $TREASURE\n  set_treasure_pos 0 2 1\n  set_cell 5 1 5 $TREASURE\n  set_treasure_pos 1 5 5\n  set_cell 9 1 9 $TREASURE\n  set_treasure_pos 2 9 9\n  pt_t=$((pt_t + 3))\n  while [ \"$pt_t\" -lt \"$TREASURE_TOTAL\" ]; do"
  );
  const { js } = await bashToJS(fs, src);
  const draws0 = (await fs.read("/dev/webgl/log")).match(/\[call\] draw /g) || [];
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
      if (p === "/dev/webgl/key") { out = (keyFrame === 0 ? "w," : keyFrame > 55 ? "q," : "") + "\n"; keyFrame++; }
      else { try { out = await fs.read(p); } catch (e) { out = ""; } }
    }
    else if (cmd === "sleep") {} // native-lowered; nothing to stub
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
      const k = keyFrame === 0 ? "w," : keyFrame > 55 ? "q," : "";
      keyFrame++;
      return k;
    }
    return origSh2ReadFile(p, enc);
  };
  const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
  await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2);
  const log = await fs.read("/dev/webgl/log");
  const draws1 = log.match(/\[call\] draw /g) || [];
  const text = stdout.join("");
  return {
    text,
    draws: draws1.length - draws0.length,
    mimes: (() => { try { return Number(rt.sh2.getVar("mime_count")); } catch { return NaN; } })(),
  };
}

const hunt = await play(2);
console.log("── run 2: flee −2");
const flee = await play(-2);
console.log("── run 3: frozen 0");
const frozen = await play(0);

const has = (r, s) => r.text.includes(s);
const kills = (r) => (r.text.match(/MIME sanitised/g) || []).length;
console.log("hunt(+2):   contact-kills=" + kills(hunt) + " mimes=" + hunt.mimes + " draws=" + hunt.draws + " score-line=" + (hunt.text.match(/Quit. Score [0-9]+/) || ["?"])[0]);
console.log("flee(−2):   contact-kills=" + kills(flee) + " mimes=" + flee.mimes + " draws=" + flee.draws + " score-line=" + (flee.text.match(/Quit. Score [0-9]+/) || ["?"])[0]);
console.log("frozen(0):  contact-kills=" + kills(frozen) + " mimes=" + frozen.mimes + " draws=" + frozen.draws + " score-line=" + (frozen.text.match(/Quit. Score [0-9]+/) || ["?"])[0]);

const ok =
  kills(hunt) > 0 && hunt.mimes < 5 &&                      // control: converged + contact
  kills(flee) === 0 && flee.mimes === 5 && flee.draws > frozen.draws && // moved but never reached
  kills(frozen) === 0 && frozen.mimes === 5 &&              // frozen: untouched, still alive
  has(hunt, "TREASURE FOUND:") && has(flee, "TREASURE FOUND:") && has(frozen, "TREASURE FOUND:");
console.log("mime speed sign test:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
