// ─── __strip-regression.mjs — `${v#pat}` / `${v%pat}` prefix/suffix strips ─
// Regression: the texture payload parser (`lt_s=${lt_s#?}` in game
// functions) silently emptied when (a) paramLiveValue ran before the
// lifts that create its native binding (full-game only — isolated
// snippets take the store path), and (b) fallbackLive read r[1] while
// the live value is the LAST arg (5-arg form). Both produced empty
// strings where bash yields stripped text — game textures uploaded
// empty ("bad data") while every other gate stayed green.
// Each case runs single-transpile via runBash (the unit under test is
// the strip lowering + runtime, not interactive line plumbing).
//
//   node __strip-regression.mjs   → "ALL STRIP CHECKS PASSED"
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };
async function t(src) {
  let out = "";
  await runBash(fs, src, {
    stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
    runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "test",
  });
  return out;
}

check("top-level ? strip", (await t('v="abcdef"\nw=${v#?}\necho "w=[$w]"\n')) === "w=[bcdef]\n");
check("top-level ?? strip", (await t('v="abcdef"\nw=${v#??}\necho "w=[$w]"\n')) === "w=[cdef]\n");
check("literal prefix strip", (await t('v="abcdef"\nw=${v#ab}\necho "w=[$w]"\n')) === "w=[cdef]\n");
check("suffix % strip", (await t('v="abcdef"\nw=${v%c*}\necho "w=[$w]"\n')) === "w=[ab]\n");
check("shared var stripped across functions", (await t('setter() {\nv="abcdef"\n}\nstripper() {\nw=${v#??}\necho "w=[$w]"\n}\nsetter\nstripper\n')) === "w=[cdef]\n");
check("self-strip in function", (await t('f() {\nx=${x#?}\n}\nx="ab"\nf\necho "x=[$x]"\n')) === "x=[b]\n");

console.log(fails === 0 ? "ALL STRIP CHECKS PASSED" : `${fails} STRIP CHECKS FAILED`);
process.exit(fails ? 1 : 0);
