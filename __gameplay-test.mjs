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
const __count = (h, c) => h.split(c).length - 1;
const __store = (n) => sh2.vars[n] ?? (process.env[n] ?? "");
const __setStore = (n, v) => sh2.setVar(n, String(v));
const __call = (n, a) => sh2.exec(n, a || []);

// ── 1. HUD: each numeral group draws its own glyph set ───────────────
score = 0; hp = 7; maxhp = 9; found_count = 3; TREASURE_TOTAL = 10;
__setStore("prev_score", ""); __setStore("prev_hp", ""); __setStore("prev_art", "");
hud_static_dirty = 1;      // rebuild geometry
digits_dirty = 1;          // and draw the numeral groups
// the REAL per-frame HUD path (draw_hud_canvas -> draw_digits): the
// digits regression hid here — draw_digits itself was fine, but this
// caller did not await it, so it flushed an empty buffer and cleared
// digits_dirty, leaving the numerals missing for good.
await __call("draw_hud_canvas");
__say("HUD_SCORE=" + __count(ov_text, "0.95 0.85 0.30"));
__say("HUD_HP=" + __count(ov_text, "0.35 0.90 0.40"));
__say("HUD_ART=" + __count(ov_text, "0.60 0.75 0.95"));

// ── 2. treasure walk-in ──────────────────────────────────────────────
await __call("start_level");
await new Promise((r) => setTimeout(r, 40));
const __bf = found_count, __bs = score, __bm = maxhp;
let __notesBefore = 0;
let __tx = -1, __tz = -1;
for (let __k = 0; __k < TREASURE_TOTAL; __k++) {
  if (sh2.arrayIndex("found", __k) !== "1") { __tx = Number(sh2.arrayIndex("tpx", __k)); __tz = Number(sh2.arrayIndex("tpz", __k)); break; }
}
__say("TREASURE_CELL=" + __tx + "," + __tz);
if (__tx > 1) {
  // stand west of it and walk east (the real input path starts a glide)
  __setStore("px", __tx - 1); __setStore("pz", __tz);
  const __dx = 1, __dz = 0;
  __notesBefore = globalThis.__noteCount();
  const __ok = await __call("try_anim_move", [__dx, __dz]);
  __say("GLIDE=" + __ok + " dest=" + sh2.arrayIndex("an", 3) + "," + sh2.arrayIndex("an", 4));
  // the glide's destination — main's anim-end copies an[3]/an[4] into px/pz
  __setStore("px", sh2.arrayIndex("an", 3)); __setStore("pz", sh2.arrayIndex("an", 4));
  // main's arrival check, verbatim: claim the cell we walked into
  await __call("get_cell", [__store("px"), 1, __store("pz")]);
  if (String(__store("gv")) === String(TREASURE)) await __call("claim_treasure", [__store("px"), __store("pz")]);
  await new Promise((r) => setTimeout(r, 40));
}
__say("CLAIM=" + found_count + "," + score + "," + maxhp + " before=" + __bf + "," + __bs + "," + __bm);
__say("NOTES=" + (globalThis.__noteCount() - __notesBefore));
await __call("get_cell", [__tx, 1, __tz]);
__say("CELL_AFTER=" + __store("gv"));
__say("AIR=" + AIR);

// ── 3. mimes: cubes step toward the player, and a VISIBLE move must
//      bump mimes_ver (the 3D view cache key — without it the cube is
//      frozen on screen while the model moves) ──────────────────────
await __call("start_level");
await new Promise((r) => setTimeout(r, 40));
const __n = Number(__store("mime_count"));
const __p0 = [];
for (let __k = 0; __k < __n; __k++) __p0.push(sh2.arrayIndex("mx", __k) + "," + sh2.arrayIndex("mz", __k));
__setStore("px", 2); __setStore("pz", 2); mime_speed = 15;   // hunt
for (let __s = 0; __s < 12; __s++) {
  await __call("update_mimes");
  await new Promise((r) => setTimeout(r, 10));
}
const __p1 = [];
for (let __k = 0; __k < __n; __k++) __p1.push(sh2.arrayIndex("mx", __k) + "," + sh2.arrayIndex("mz", __k));
__say("MIMES=" + __n);
__say("MOVED=" + __p0.filter((p, i) => p !== __p1[i]).length);
__say("MOVE0=" + __p0[0] + "->" + __p1[0]);

// a 2-step sightline: put the player where a corridor runs straight,
// then place a mime 2 cells ahead so it steps INTO the visible cell
// (a real move, not the adjacent-player attack that would kill it and
// bump the version for the wrong reason)
await __call("start_level");
await new Promise((r) => setTimeout(r, 40));
let __ax = -1, __az = -1, __bx = -1, __bz = -1;
for (let __sx = 1; __sx <= 8 && __bx === -1; __sx++) {
  for (let __sz = 1; __sz <= 8 && __bx === -1; __sz++) {
    await __call("get_cell", [__sx, 1, __sz]);
    if (String(__store("gv")) !== String(AIR)) continue;
    __setStore("px", __sx); __setStore("pz", __sz);
    await __call("compute_display");
    for (const [__dx, __dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const __c1x = __sx + __dx, __c1z = __sz + __dz;
      const __c2x = __c1x + __dx, __c2z = __c1z + __dz;
      await __call("cell_visible", [__c1x, __c1z]);
      const __vis = String(cv);
      await __call("get_cell", [__c1x, 1, __c1z]);
      const __aAir = String(__store("gv")) === String(AIR);
      await __call("get_cell", [__c2x, 1, __c2z]);
      const __bAir = String(__store("gv")) === String(AIR);
      if (__vis === "1" && __aAir && __bAir) { __ax = __c1x; __az = __c1z; __bx = __c2x; __bz = __c2z; break; }
    }
  }
}
__say("SIGHTLINE=" + __ax + "," + __az + "|" + __bx + "," + __bz);
if (__bx !== -1) {
  const __v0 = mimes_ver;
  __setStore("mime_count", 1);
  __setStore("mx[0]", __bx); __setStore("mz[0]", __bz);
  __setStore("mime_lookup[" + (__bz * MAP_W + __bx) + "]", 0);
  await __call("update_mimes");
  await new Promise((r) => setTimeout(r, 30));
  __say("VMOVED=" + sh2.arrayIndex("mx", 0) + "," + sh2.arrayIndex("mz", 0));
  __say("VWANT=" + __ax + "," + __az);
  __say("VER=" + __v0 + "->" + mimes_ver);
}
`;
let out = "";
await runTranspiled(fs, js + driver, {
  stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "gameplay-test",
});
if (process.env.GP_DEBUG) console.log(out);
const num = (k) => { const m = new RegExp("^" + k + "=(\\d+)", "m").exec(out); return m ? Number(m[1]) : null; };
const str = (k) => { const m = new RegExp("^" + k + "=(.*)$", "m").exec(out); return m ? m[1].trim() : null; };

// a glyph is <=15 lit rects; require a real group (>= 6) so a stray rect
// or a label pixel cannot satisfy the check
check("HUD: score numerals drawn (gold)", (num("HUD_SCORE") || 0) >= 6, "rects=" + num("HUD_SCORE"));
check("HUD: HP numerals drawn (green)", (num("HUD_HP") || 0) >= 6, "rects=" + num("HUD_HP"));
check("HUD: ART numerals drawn (blue)", (num("HUD_ART") || 0) >= 6, "rects=" + num("HUD_ART"));

const claim = /CLAIM=(\d+),(\d+),(\d+) before=(\d+),(\d+),(\d+)/.exec(out);
if (!claim) {
  check("treasure: walk-in claim observed", false, out.slice(-160));
} else {
  const [f, s, m, bf, bs, bm] = claim.slice(1).map(Number);
  check("treasure: glide targets the treasure cell", str("GLIDE") === "true dest=" + str("TREASURE_CELL"), str("GLIDE"));
  check("treasure: walking into it claims (found +1)", f === bf + 1, `${bf} → ${f}`);
  check("treasure: claim scores +100", s === bs + 100, `${bs} → ${s}`);
  check("treasure: claim grants +1 max HP", m === bm + 1, `${bm} → ${m}`);
  check("treasure: claimed cell becomes AIR", num("CELL_AFTER") === num("AIR"), "cell=" + num("CELL_AFTER") + " air=" + num("AIR"));
  check("treasure: claiming plays sounds", (num("NOTES") || 0) > 0, "note writes=" + num("NOTES"));
}

const sl = str("SIGHTLINE");
if (!sl || sl.includes("-1")) {
  check("mimes: a visible corridor exists to test with", false, sl || "none");
} else {
  check("mimes: cubes step toward the player", (num("MOVED") || 0) > 0,
    `${num("MOVED")}/${num("MIMES")} moved ${str("MOVE0")}`);
  check("mimes: visible cube steps into the viewed cell", str("VMOVED") === str("SIGHTLINE").split("|")[0],
    `${str("VMOVED")} want ${str("SIGHTLINE").split("|")[0]}`);
  const v = /VER=(\d+)->(\d+)/.exec(out);
  check("mimes: visible move bumps mimes_ver (3D cache key)", v && Number(v[2]) > Number(v[1]), v ? `${v[1]} → ${v[2]}` : "no VER");
}
console.log(fails === 0 ? "ALL GAMEPLAY CHECKS PASSED" : `${fails} GAMEPLAY CHECKS FAILED`);
process.exit(fails ? 1 : 0);
