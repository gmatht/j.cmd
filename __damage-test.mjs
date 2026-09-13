// ─── __damage-test.mjs — damaged blocks show cracks, not black ───────
// The crack overlay is a dark (28,28,28) texture with alpha 255 on the
// crack lines and alpha 0 elsewhere. Its blend weight in the fragment
// shader was `mix = damage * cr_a` (clamped 127): with cr_a = 255 the
// weight saturates on the FIRST hit, so the crack texel takes 127/128 ≈
// 99% of the pixel and a damaged block renders as near-black instead of
// the block's own colour crossed by dark cracks. The weight must scale
// with damage.
//
// This evaluates the maths BOTH copies of the shader actually run —
// the generator-emitted fixed-point fragment (authored in bash in
// www/bin/mimecroft.sh) and the float-native rewrite the GPU optimiser
// substitutes for it (OPT_MAIN in src/shglsl-opt.js) — on a damaged
// grass block, and asserts the cracked pixel stays recognisably the
// block's colour at the first hit while getting darker as damage rises.
//
//   node __damage-test.mjs   → "ALL DAMAGE CHECKS PASSED"
import { readFileSync } from "node:fs";

const game = readFileSync("www/bin/mimecroft.sh", "utf8");
const opt = readFileSync("src/shglsl-opt.js", "utf8");

// crack texture constants, read from the generator that makes it
const crackSrc = readFileSync("www/examples/textures/texture-crack.sh", "utf8");
const mCrack = /crack_set \$\(\(cy \* SIZE \+ cx\)\) (\d+) (\d+) (\d+) (\d+)/.exec(crackSrc);
if (!mCrack) { console.log("FAIL: could not read the crack texel from texture-crack.sh"); process.exit(1); }
const [, CR_R, CR_G, CR_B, CR_A] = mCrack.map(Number);

// the fixed-point weight, parsed from the game's own fragment authoring
const mGame = /mix=\$\(\(damage \* cr_a( \/ \d+)?\)\)/.exec(game);
if (!mGame) { console.log("FAIL: no `mix=$((damage * cr_a…))` in mimecroft.sh"); process.exit(1); }
const gameDivisor = mGame[1] ? Number(mGame[1].trim().slice(2)) : 1;

// the optimiser's float-native weight (/ divisor), from OPT_MAIN
const mOpt = /g_mix = min\(\(\(float\(uDamage\) \* float\(int\(_crack\.a \* ([\d.]+)\)\)\) \/ ([\d.]+)\), ([\d.]+)\);/.exec(opt);
if (!mOpt) { console.log("FAIL: no optimised g_mix in shglsl-opt.js"); process.exit(1); }
const optAScale = Number(mOpt[1]), optDivisor = Number(mOpt[2]), optCap = Number(mOpt[3]);

// one damaged pixel: base = the block's lit colour (0..255), the crack
// texel on a crack line. The shader bridges the texture channels in the
// 0..127 scale (the optimiser's own `int(_tex.r * 255.0)` / crack
// `int(_crack.r * 127.0)` are the ground truth mirrored here).
const base = 200;
const crackTexel = Math.floor(CR_R * optAScale / 255);   // 28 → 13
const alpha = Math.floor(CR_A * optAScale / 255);        // 255 → 127
const fixed = (damage) => {
  let mix = Math.floor(damage * alpha / gameDivisor);    // bash integer maths
  if (mix > 127) mix = 127;
  return base - Math.floor((base - crackTexel) * mix / 128);
};
const optimised = (damage) => {
  const mix = Math.min(damage * Math.floor((CR_A / 255) * optAScale) / optDivisor, optCap);
  return base - (base - crackTexel) * (mix / 128);
};

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

console.log(`crack texel r=${CR_R} a=${CR_A} → shader ${crackTexel}/127; divisor game=${gameDivisor} opt=${optDivisor}`);
check("the crack overlay is dark (near-black lines)", crackTexel < 64, `texel=${crackTexel}`);
check("DAMAGE=1 does not black out the block (fixed-point shader)",
  fixed(1) >= base * 0.5, `${fixed(1)}/255 (base ${base})`);
check("DAMAGE=1 does not black out the block (optimised shader)",
  optimised(1) >= base * 0.5, `${optimised(1).toFixed(0)}/255 (base ${base})`);
check("cracks darken as damage rises (fixed-point)",
  fixed(1) > fixed(2) && fixed(2) > fixed(4), `${fixed(1)} > ${fixed(2)} > ${fixed(4)}`);
check("cracks darken as damage rises (optimised)",
  optimised(1) > optimised(2) && optimised(2) > optimised(4),
  `${optimised(1).toFixed(0)} > ${optimised(2).toFixed(0)} > ${optimised(4).toFixed(0)}`);
check("a badly damaged block is clearly cracked (≥75% crack at damage 4)",
  fixed(4) <= base * 0.35, `${fixed(4)}/255`);
check("both shader copies agree on the weight (no drift)",
  gameDivisor === optDivisor && Math.abs(fixed(2) - optimised(2)) <= 3,
  `game=${fixed(2)} opt=${optimised(2).toFixed(0)}`);
console.log(fails === 0 ? "ALL DAMAGE CHECKS PASSED" : `${fails} DAMAGE CHECKS FAILED`);
process.exit(fails ? 1 : 0);
