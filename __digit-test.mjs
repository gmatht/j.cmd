// ─── __digit-test.mjs — the 3D HUD digits render (score/HP numerals) ─
// draw_digits() renders score/HP as glyph rects into ov_text (flushed to
// /dev/webgl/hud). A lift/agreement regression silenced it entirely
// (ov_text stays empty — no digits on the 3D view) while terminal text,
// isolated draw_char calls, and every other gate stayed green. Runs the
// REAL game functions in FULL-PROGRAM context (transpiled together, so
// whole-program lift decisions apply — isolated snippets don't reproduce)
// with the trailing `main` call dropped (defs only, no game loop).
//
//   node __digit-test.mjs   → "ALL DIGIT CHECKS PASSED"
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";
import { readFileSync } from "node:fs";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

let game = readFileSync("www/bin/mimecroft.sh", "utf8");
game = game.replace(/\nmain\s*$/, "\n");
const src = game + `
score=100
hp=11
maxhp=11
prev_score=""
prev_hp=""
d_W=8
d_Y=100
d_score_dx=10
d_hp_dx=10
d_hpmax_dx=10
GLP_W=8
GLP_H=11
ov_text=""
draw_digits
echo "ovlen=\${#ov_text}"
`;
let out = "";
await runBash(fs, src, {
  stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "digit-test",
});
const m = /ovlen=(\d+)/.exec(out);
const ovlen = m ? Number(m[1]) : -1;
// score 100 (4 digits) + hp 11/11 (5 digits incl slash) → dozens of rects;
// each rect appends a line, so hundreds of bytes. Zero means silent.
check("draw_digits emits glyph rects", ovlen > 200, "ovlen=" + ovlen);
console.log(fails === 0 ? "ALL DIGIT CHECKS PASSED" : `${fails} DIGIT CHECKS FAILED`);
process.exit(fails ? 1 : 0);
