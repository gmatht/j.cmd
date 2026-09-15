// ─── __lift-key-test.mjs — the reinstated exact-key lift ─────────────
// The week-ago transpiler lifted every index var to a native binding; the
// Sep-12 guard (black-3D fix) then blocked ALL of them whenever the var
// appeared in any "$v" string — including the storage-neutral exact-key
// shape (`sh2.arrayIndex("a", "$k")`), which the post-lift interpolation
// carries as a bare Identifier without moving any array storage.
//
// This test pins the careful reinstatement (src/lower.js liftLocalVars):
// a key-only index var lifts AND the whole-array `${a[*]}` read on the
// same array keeps matching bash (the 05 killer shape — a NAME-position
// lift would empty the star, so 05's sp_i must stay on the store).
//
//   node __lift-key-test.mjs   → "ALL LIFT-KEY CHECKS PASSED"
import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { execFileSync } from "node:child_process";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const src = readFileSync("upstream-repros/07-exact-key-lift.sh", "utf8");
const want = execFileSync("bash", ["upstream-repros/07-exact-key-lift.sh"], { encoding: "utf8" });

// 1) safety: the transpiled shell prints what bash prints.
let got = "";
await runBash(fs, src, {
  stdout: { write: (s) => { got += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "07-exact-key-lift.sh",
});
check("07 stdout matches bash", got === want, `bash=${JSON.stringify(want.trim())} transpiled=${JSON.stringify(got.trim())}`);

// 2) the optimisation is actually active: `k` lives in a native binding
// and the key travels as a bare Identifier (no store expansion).
const { js } = await bashToJS(fs, src);
// strip the transpiler's own header (it embeds the bash source as //
// comments, which would match the structural greps below).
const code = js.split("\n").filter((l) => !l.startsWith("//")).join("\n");
check("key var lifted to a native binding", /(^|[\s;])k = sh2\.positional\[0\]/.test(code));
check("exact key is a bare Identifier", /sh2\.arrayIndex\("a", k\)/.test(code));
check("no store-expanded key remains", !/sh2\.arrayIndex\("a", "\$k"\)/.test(code));
// 3) ...while the star still reads the store (storage never moved).
check("star still reads the store array", /sh2\.getVar\("a\[\*\]"\)/.test(code));

// 4) the 05 boundary: a NAME-position index var LIFTS (its writes go
// through runtime templates) while an array WITH whole-array readers
// stays stored (the star pins it) — lift without fold. Repro 05's stdout
// passing proves the combination is sound; the shapes below prove both
// halves actually fired.
const src05 = readFileSync("upstream-repros/05-param-only-use-in-index.sh", "utf8");
const { js: js05raw } = await bashToJS(fs, src05);
const code05 = js05raw.split("\n").filter((l) => !l.startsWith("//")).join("\n");
check("05 index var lifts to a native binding", /(^|[\s;])sp_i = String\(sh2\.positional\[0\]/.test(code05));
check("05 writes travel as runtime templates", /setVar\(`tpx\[\$\{sp_i\}\]`/.test(code05));
check("05 star still reads the store array", /getVar\("tpx\[\*\]"\)/.test(code05));
check("05 array never folds native", !/\btpx\[Number\(/.test(code05));

console.log(fails === 0 ? "ALL LIFT-KEY CHECKS PASSED" : `${fails} LIFT-KEY CHECKS FAILED`);
process.exit(fails ? 1 : 0);
