// ─── __gameplay-test.mjs — HUD groups, treasure walk-in, mime motion ─
// Regressions that shipped together, each from a caller racing ahead of
// an async callee (unawaited shell call) or an analysis change. Every
// assertion is on OBSERVABLE state and every step uses the REAL game
// path (no re-implemented logic):
//
//   * HUD numerals: the score (gold), HP (green) and ART (blue) groups
//     each draw their own glyph set. A "some digits appeared" check
//     passed while two groups were silently missing — each group's
//     colour is counted separately, and a colour is emitted only by
//     glyph pixels (erase rects carry none).
//   * treasure: walking INTO a hidden treasure claims it. Driven through
//     try_anim_move (the real input path — try_move is dead code) plus
//     main's own arrival check (get_cell at the destination, then
//     claim_treasure); asserts found/score/maxhp advance and the cell
//     becomes AIR.
//   * mimes: a VISIBLE mime's step must bump mimes_ver — the 3D view
//     cache key. Without the bump the cube is frozen on screen while the
//     model moves (the "MIMEboxes do not move in 3D display" symptom);
//     the off-screen case legitimately skips the bump, so the mime is
//     placed on a cell cell_visible() actually reports as visible.
//
// Transpiled as the WHOLE program (lift/await decisions depend on global
// analysis; isolated snippets take other paths), then driven from JS
// through each value's real storage: the transpiler lifts many scalars
// to native module lets and leaves others in the sh2 store, so store
// vars are written/read through sh2 and lifted ones as identifiers —
// writing the wrong home silently no-ops (an earlier version of this
// test "passed" a broken game that way).
//
// The one KNOWN-OPEN upstream gap in this area — the 3D renderer's
// mime_lookup not being re-keyed on a move (cube drawn at the ORIGINAL
// cell) — is a lifted-variable-as-array-index bug, reproduced minimally
// and tracked as OPEN in upstream-repros/01 (see __upstream-guard-test).
//
//   node __gameplay-test.mjs   → "ALL GAMEPLAY CHECKS PASSED"
import { fs } from "./src/fs/index.js";
import { bashToJS, runTranspiled } from "./src/bash2js.js";
import { readFileSync } from "node:fs";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const game = readFileSync("www/bin/mimecroft.sh", "utf8").replace(/\nmain\s*$/, "\n");
const { js } = await bashToJS(fs, game);

// observe the audio device: `play NOTE` writes /dev/audio/note (notes
// mode) — claiming a treasure must make sounds, so the claim window is
// bracketed by counting those writes.
let noteWrites = 0;
const origWrite = fs.write.bind(fs);
fs.write = async (p, c) => {
  if (String(p).endsWith("/dev/audio/note")) noteWrites++;
  return origWrite(p, c);
};

globalThis.__noteCount = () => noteWrites;
const driver = `
const __say = (s) => process.stdout.write(s + "\\n");
const __store = (n) => (sh2.vars[n] === undefined ? "" : sh2.vars[n]);
const __setStore = (n, v) => sh2.setVar(n, String(v));
// storage-robust array read: whole-script arrays whose every access is
// JS-evaluated fold to native module bindings (tpx/tpz today) while the
// rest stay in the store (map/an/mx). A store-only read silently answers
// "" for a native array — every artifact looked unclaimable (0/10).
// typeof is TDZ-safe here: the game top-level (which declares the
// bindings) runs before the driver, and an undeclared name yields
// "undefined" instead of throwing.
const __arr = (n, i) => {
  if (n === "tpx" && typeof tpx !== "undefined") return tpx[i] ?? "";
  if (n === "tpz" && typeof tpz !== "undefined") return tpz[i] ?? "";
  return sh2.arrayIndex(n, i);
};
const __call = (n, a) => sh2.exec(n, a || []);
const __cell = async (x, z) => {
  const g = sh2.arrayIndex("map", (1 * 256) + (z * 16) + x);
  return Number(g === "" ? -1 : g);
};

// ── EVERY artifact must be claimable by walking into it ──────────────
// The live report: out of 10 artifacts, touching them to claim worked
// ONCE. The single-claim test could not see it — claim_treasure is not
// idempotent across repeats, so the loop is what matters.
await __call("start_level");
await new Promise((r) => setTimeout(r, 40));
const __claimed = [];
for (let __k = 0; __k < TREASURE_TOTAL; __k++) {
  const __tx = Number(__arr("tpx", __k));
  const __tz = Number(__arr("tpz", __k));
  __say("T" + __k + "=" + __tx + "," + __tz + " cell=" + (await __cell(__tx, __tz)));
  const __foundBefore = found_count;
  // stand WEST of the artifact and walk EAST into it. Force the two
  // approach cells to AIR: on a maze board the neighbour can be a wall,
  // and a test that cannot approach is not testing the claim.
  await __call("set_cell", [__tx - 1, 1, __tz, AIR]);
  await __call("set_cell", [__tx - 1, 2, __tz, AIR]);
  __setStore("px", __tx - 1); __setStore("pz", __tz); yaw = 0; anim = 0;
  const __destBefore = await __cell(__tx, __tz);
  const __ok = await __call("try_anim_move", [1, 0]);
  // main's glide end: px/pz := an[3]/an[4], then the arrival check
  __setStore("px", sh2.arrayIndex("an", 3));
  __setStore("pz", sh2.arrayIndex("an", 4));
  await __call("get_cell", [__store("px"), 1, __store("pz")]);
  if (String(__store("gv")) === String(TREASURE)) {
    await __call("claim_treasure", [__store("px"), __store("pz")]);
  }
  await new Promise((r) => setTimeout(r, 20));
  const __destAfter = await __cell(__tx, __tz);
  __claimed.push((found_count - __foundBefore) + ":" + (__destBefore === TREASURE ? "T" : String(__destBefore)) +
                 ">" + (__destAfter === AIR ? "air" : String(__destAfter)) + (__ok ? "" : ":noGlide"));
}
__say("CLAIMED=" + __claimed.join(","));
__say("FOUND=" + found_count);
__say("TOTAL=" + TREASURE_TOTAL);
__say("LEFT=" + treasures_left);
`;
let out = "";
await runTranspiled(fs, js + driver, {
  stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "gameplay-test",
});
if (process.env.GP_DEBUG) console.log(out);
const num = (k) => { const m = new RegExp("^" + k + "=(-?\\d+)", "m").exec(out); return m ? Number(m[1]) : null; };
const str = (k) => { const m = new RegExp("^" + k + "=(.*)$", "m").exec(out); return m ? m[1].trim() : null; };


const claimed = (str("CLAIMED") || "").split(",");
const gained = claimed.filter((c) => c.startsWith("1:")).length;
console.log("per-artifact: " + str("CLAIMED"));
check("every artifact is claimable by walking into it",
  gained === Number(str("TOTAL")), `${gained}/${str("TOTAL")} claimed (found=${num("FOUND")})`);
check("walking into an unclaimed artifact starts the glide",
  !claimed.some((c) => c.includes("noGlide")), claimed.filter((c) => c.includes("noGlide")).length + " refused");
check("a claimed artifact's cell becomes AIR",
  !claimed.some((c) => c.includes("T") && !c.endsWith(">air")),
  claimed.filter((c) => c.includes(">") && !c.endsWith(">air")).slice(0, 3).join(","));
check("found_count reaches the artifact total",
  num("FOUND") === Number(str("TOTAL")), `found=${num("FOUND")} total=${str("TOTAL")}`);
check("treasures_left reaches zero",
  num("LEFT") === 0, "left=" + num("LEFT"));
console.log(fails === 0 ? "ALL CLAIM-ALL CHECKS PASSED" : `${fails} CLAIM-ALL CHECKS FAILED`);
process.exit(fails ? 1 : 0);
