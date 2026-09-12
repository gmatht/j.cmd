// ─── __digit-test.mjs — the 3D HUD digits render (score/HP numerals) ─
// draw_digits() renders score/HP as glyph rects into ov_text (flushed to
// /dev/webgl/hud). A lift/agreement regression silenced it entirely
// (ov_text stays empty — no digits on the 3D view) while terminal text,
// isolated draw_char calls, and every other gate stayed green.
//
// Shape matters: the game source is transpiled ALONE (whole-program
// lift decisions apply), then driven from JS (hud_build_static for real
// positions, state set, draw_digits called, ov_text measured). Appending
// bash driver assignments perturbs global analysis and masks the bug;
// calling with real computed geometry also checks rects land on-screen
// (finite NDC), not just nonzero length.
//
//   node __digit-test.mjs   → "ALL DIGIT CHECKS PASSED"
import { fs } from "./src/fs/index.js";
import { runTranspiled } from "./src/bash2js.js";
import { bashToJS } from "./src/bash2js.js";
import { readFileSync } from "node:fs";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const game = readFileSync("www/bin/mimecroft.sh", "utf8").replace(/\nmain\s*$/, "\n");
const { js } = await bashToJS(fs, game);
const driver = `
score = 100; hp = 11; maxhp = 11;
sh2.vars.prev_score = "";
sh2.vars.prev_hp = "";
await sh2.exec("hud_build_static", []);
ov_text = "";
await sh2.exec("draw_digits", []);
process.stdout.write("ovlen=" + ov_text.length + "\\n");
process.stdout.write("ovhead=" + ov_text.slice(0, 400) + "\\n");
`;
let out = "";
await runTranspiled(fs, js + driver, {
  stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "digit-test",
});
const m = /ovlen=(\d+)/.exec(out);
const ovlen = m ? Number(m[1]) : -1;
check("draw_digits emits glyph rects", ovlen > 200, "ovlen=" + ovlen);
const oi = out.indexOf('ovhead=');
const head = oi >= 0 ? out.slice(oi + 7) : '';
const nums = head.split(/\s+/).filter((t) => t !== '' && t !== 'E' && t !== 'R').map(Number);
check("digit rects land on-screen (finite NDC)", nums.length >= 7 && nums.every(Number.isFinite),
  head.slice(0, 80));
console.log(fails === 0 ? "ALL DIGIT CHECKS PASSED" : `${fails} DIGIT CHECKS FAILED`);
process.exit(fails ? 1 : 0);
