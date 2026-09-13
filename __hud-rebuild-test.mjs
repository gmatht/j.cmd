// ─── __hud-rebuild-test.mjs — HUD digit groups survive a layer rebuild ─
// A static-layer rebuild (hud_static_dirty: a new level, a claim, the
// first frame after startup) emits a clear (`C`) of the persistent HUD
// layer, so EVERY dynamic group must be repainted. draw_digits redraws a
// group only when its value differs from prev_*, so unless the rebuild
// resets those gates the stable groups blank out: ART (artifacts found)
// and LIC (licence) do not change for long stretches, so they disappeared
// on screen the moment the player moved (score/HP survived only because
// they change often enough to re-trigger their own gate).
//
//   node __hud-rebuild-test.mjs   → "ALL HUD REBUILD CHECKS PASSED"
import { fs } from "./src/fs/index.js";
import { bashToJS, runTranspiled } from "./src/bash2js.js";
import { readFileSync } from 'node:fs';
const err = (...a) => process.stderr.write(a.join(' ') + '\n');
const game = readFileSync("www/bin/mimecroft.sh", "utf8").replace(/\nmain\s*$/, '\n');
const { js } = await bashToJS(fs, game);
const driver = `
const __count = (h, c) => h.split(c).length - 1;
score = 0; hp = 7; maxhp = 9; found_count = 3; TREASURE_TOTAL = 10;
sh2.setVar("prev_score",""); sh2.setVar("prev_hp",""); sh2.setVar("prev_art",""); sh2.setVar("prev_lic","");
hud_static_dirty = 1; digits_dirty = 1;
await sh2.exec("draw_hud_canvas", []);
process.stdout.write("FRAME1 art=" + __count(ov_text, "0.60 0.75 0.95") + " lic=" + __count(ov_text, "0.95 0.60 0.30") + "\\n");
// second frame: values UNCHANGED, but the static layer is rebuilt
// (this is what a move/level start/claim does) — the clear wipes the
// digits, so every group must be redrawn
hud_static_dirty = 1; digits_dirty = 1;
await sh2.exec("draw_hud_canvas", []);
process.stdout.write("FRAME2 art=" + __count(ov_text, "0.60 0.75 0.95") + " lic=" + __count(ov_text, "0.95 0.60 0.30") + " clears=" + __count(ov_text, "\\nC\\n") + "\\n");
`;
let out = "";
await runTranspiled(fs, js + driver, {
  stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "hud-rebuild-test",
});
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };
// tiny key=value parser (no regex escaping games inside the generated driver)
const kv = (line, key) => {
  const seg = out.split(String.fromCharCode(10)).find((l) => l.startsWith(line + " "));
  if (!seg) return -1;
  for (const part of seg.split(" ")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === key) return Number(part.slice(eq + 1));
  }
  return -1;
};
check("first frame draws the ART group (blue)", kv("FRAME1", "art") >= 6, "art=" + kv("FRAME1", "art"));
check("first frame draws the LIC digit (orange)", kv("FRAME1", "lic") >= 3, "lic=" + kv("FRAME1", "lic"));
check("layer rebuild with UNCHANGED values still repaints ART", kv("FRAME2", "art") >= 6, "art=" + kv("FRAME2", "art"));
check("layer rebuild with UNCHANGED values still repaints LIC", kv("FRAME2", "lic") >= 3, "lic=" + kv("FRAME2", "lic"));
console.log(fails === 0 ? "ALL HUD REBUILD CHECKS PASSED" : `${fails} HUD REBUILD CHECKS FAILED`);
process.exit(fails ? 1 : 0);
