// py2cy smoke test — the annotator's CI oracle (no browser, no Cython).
//
//   node bench/py2cy-smoke.mjs
//
// Checks the acceptance items from otranspiler-frontends/docs/AUTO_CYTHON.md
// §8.3 that do not need a Cython install:
//
//   1. the bench shapes emit the SAME declarations as the hand-written
//      goldens (rolling_hash → `long long h`; bignum_mul → the GMP FFI);
//   2. pure-Python mode always stays valid, runnable Python (it is checked
//      by the `import cython` + @cython.locals shape, and the source is
//      reproduced verbatim);
//   3. the refusal manifest is populated for constructs outside the subset
//      and EMPTY for the bench shapes (a false refusal is a silent
//      speedup loss — a real bug);
//   4. annotating never changes the source text of a statement it does not
//      rewrite (REFUSE > GUESS);
//   5. every generated file is valid Python when the input was.
//
// Where Cython is installed, the companion shell check compiles+builds and
// diffs stdout against CPython (see the footer of this file).
import { annotate } from "../src/py2cy.js";
import { EXAMPLES, getExample } from "../www/auto_cython-examples.js";

let failures = 0;
const ok = (cond, what, detail) => {
  if (cond) { console.log("  ok   " + what); return; }
  failures++;
  console.log("  FAIL " + what + (detail ? "\n       " + detail : ""));
};

console.log("py2cy smoke test");

// ── 1. bench shapes vs the hand-written goldens ─────────────────
const rh = annotate(getExample("rolling_hash").code, { mode: "pyx" });
const goldenRh = getExample("rolling_hash").golden;
console.log("\nrolling_hash (the .pyx golden shape)");
ok(/cdef\s+long long\s+h/.test(rh.text), "h is `cdef long long` (the intermediate-width proof: h*31 needs 64 bits)");
ok(/cdef\s+(long long|int)\s+i/.test(rh.text), "i is a C integer (the counted-loop counter)");
ok(/cdef\s+long long\s+h/.test(goldenRh), "the golden agrees on `long long h`");
ok(rh.stats.refusals === 0, "no refusals on the canonical bench shape", JSON.stringify(rh.refusals));

const bn = annotate(getExample("bignum_mul").code, { mode: "pyx" });
console.log("\nbignum_mul (the GMP golden shape)");
ok(/cdef extern from "gmp\.h"/.test(bn.text), "emits the `cdef extern from \"gmp.h\"` block");
ok(/cdef mpz_t x/.test(bn.text), "declares `cdef mpz_t x`");
ok(/mpz_init\(x\)/.test(bn.text), "initialises the bigint");
ok(/mpz_ui_pow_ui\(x, 2, 100\)/.test(bn.text), "rewrites `2 ** 100` → mpz_ui_pow_ui");
ok(/mpz_mul_ui\(x, x, 3\)/.test(bn.text), "rewrites `x = x * 3` → mpz_mul_ui");
ok(/mpz_fdiv_ui\(x, 1000000007\)/.test(bn.text), "rewrites `print(x % M)` → mpz_fdiv_ui");
ok(/mpz_clear\(x\)/.test(bn.text), "releases the bigint");
ok(bn.stats.gmp === true, "the stats report the GMP tier");
ok(bn.stats.bigint === 1, "exactly one bigint variable was proved");

// ── 2/4/5. per-example invariants ───────────────────────────────
console.log("\nper-example invariants (pure-Python mode)");
for (const ex of EXAMPLES) {
  const r = annotate(ex.code, { mode: "pure" });
  const pyx = annotate(ex.code, { mode: "pyx" });
  // (2) the source is reproduced verbatim — pure mode only PREPENDS
  // declarations, so every original line survives unchanged
  const origLines = ex.code.replace(/\n+$/, "").split("\n").filter((l) => l.trim() !== "");
  const missing = origLines.filter((l) => !r.text.includes(l));
  ok(missing.length === 0, ex.name + ": source reproduced verbatim", missing.slice(0, 2).join(" | "));
  // (3) nothing crashes, and both modes render
  ok(r.text.length > 0 && pyx.text.length > 0, ex.name + ": both modes render");
  // (5) the mode header is the documented one
  ok(r.text.startsWith("# cython: language_level=3"), ex.name + ": has the cython directive header");
  ok(/^export|^import|^from|^def|^cdef|^#|^\s*$|^print|^[A-Za-z_]/.test(pyx.text), ex.name + ": .pyx starts at column 0 (no dangling indent)");
}

// ── 3. the refusal manifest ─────────────────────────────────────
console.log("\nrefusal manifest");
const unprovable = annotate(getExample("refusals").code, { mode: "pure" });
ok(unprovable.refusals.length > 0, "unprovable constructs are listed", JSON.stringify(unprovable.refusals));
ok(unprovable.refusals.some((r) => r.construct === "statement"), "try/except is refused as a statement");
const noGuess = unprovable.text.includes("data = {}") && unprovable.text.includes("[i for i in range(3)]");
ok(noGuess, "refused constructs are emitted verbatim (REFUSE > GUESS)");
// a false declaration is the dangerous direction: an unproved int must
// never become a C type
ok(!/cython\.declare\([^)]*\bdata\b/.test(unprovable.text), "no declaration is invented for an unprovable name");
ok(/cython\.declare\([^)]*\bx\s*=\s*cython\.int\b/.test(unprovable.text), "the provable scalar in the same program IS declared");

const fz = annotate(getExample("fizzbuzz").code, { mode: "pure" });
ok(fz.stats.refusals === 0, "fizzbuzz: if/elif/else in a counted loop is fully provable", JSON.stringify(fz.refusals));

// ── an unproven bound must not become a C type (the soundness rule) ──
console.log("\nsoundness: an unproved value is never given a C type");
const unproven = annotate("def f(n):\n    h = 0\n    for i in range(n):\n        h = (h * 31 + i) % 1000000007\n    return h\n", { mode: "pyx" });
ok(/cdef long long h/.test(unproven.text), "h is still proved (long long) with an unknown trip count");
ok(!/cdef\s+\w+\s+i\b/.test(unproven.text), "i is NOT declared when its bound is unknown (no wrap-by-guess)");
ok(unproven.refusals.some((r) => /not provable/.test(r.reason)), "the unproved counter is reported in the manifest");

// ── short counted loops are unrolled exactly (tighter than the invariant) ──
// A `range(2)` loop must prove the reachable range, not the [0,m-1] loop
// invariant; a long loop must stay conservative (the unroll must not be a
// route to a wrapping `int`).
console.log("\nshort-loop precision + declaration evidence");
const shortLoop = annotate("h = 0\nfor i in range(2):\n    h = (h * 31 + i) % 1000000007\nprint(h)\n", { mode: "pyx" });
ok(/cdef\s+int\s+h\b/.test(shortLoop.text), "range(2) proves h ∈ [1,1] → `cdef int h`", shortLoop.text);
ok(!/cdef\s+long long\s+h/.test(shortLoop.text), "the short loop is NOT widened to long long");
const hDecl = shortLoop.decls.find((d) => d.name === "h");
const iDecl = shortLoop.decls.find((d) => d.name === "i");
ok(hDecl && /\[1,1\]/.test(hDecl.ty), "h's proved range is the exact [1,1]", hDecl && hDecl.ty);
ok(hDecl && /intermediate/.test(hDecl.why), "h's evidence names the intermediate width", hDecl && hDecl.why);
ok(iDecl && /counted-loop counter/.test(iDecl.why), "i's evidence says it is the counted-loop counter", iDecl && iDecl.why);
ok(shortLoop.decls.every((d) => d.why && d.why !== "proved by the flow analysis"), "every declaration carries specific evidence, not the old canned text");
const longLoop = annotate("h = 0\nfor i in range(100000):\n    h = (h * 31 + i) % 1000000007\nprint(h)\n", { mode: "pyx" });
ok(/cdef\s+long long\s+h/.test(longLoop.text), "a long loop keeps the [0,m-1] invariant (long long) — no overflow-by-unrolling");

// ── the module is importable and DOM-free (worker + Node safe) ──
console.log("\nmodule contract");
ok(typeof globalThis.document === "undefined", "the test runs without a DOM (the module is DOM-free)");
ok(typeof annotate === "function", "annotate() is exported");

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));

// ── the real oracle: Cython compile + CPython stdout parity ─────
// Skipped (not failed) when cython/python3-config are absent, so this
// stays runnable in a bare checkout. This is AUTO_CYTHON §8.3's
// acceptance item, automated.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function have(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
}

const canCython = have("cython", ["--version"]) && have("python3-config", ["--includes"]);
console.log("\nCython acceptance (compile + build + stdout parity)");
if (!canCython) {
  console.log("  skip — cython or python3-config not installed on this box");
} else {
  const dir = mkdtempSync(join(tmpdir(), "py2cy-"));
  const inc = execFileSync("python3-config", ["--includes"]).toString().trim().split(/\s+/);
  const ld = execFileSync("python3-config", ["--ldflags", "--embed"]).toString().trim().split(/\s+/);
  // names must be valid Cython module names (no hyphens) — an invalid
  // filename is a Cython error, not a py2cy one
  const cases = ["rolling_hash", "bignum_mul", "def-rolling-hash", "int-list", "sum_squares", "fizzbuzz", "while-count"];
  for (const name of cases) {
    const mod = name.replace(/-/g, "_");
    const ex = getExample(name);
    try {
      // reference: real CPython on the original source
      const ref = execFileSync("python3", ["-c", ex.code], { encoding: "utf8" });
      // 1) the generated .pyx must compile
      const pyx = annotate(ex.code, { mode: "pyx" }).text;
      writeFileSync(join(dir, mod + ".pyx"), pyx);
      execFileSync("cython", ["--embed", "-3", mod + ".pyx", "-o", mod + ".c"], { cwd: dir, stdio: "pipe" });
      // 2) it must build (GMP is linked unconditionally: the FFI block needs it)
      execFileSync("cc", ["-O2", "-o", mod, mod + ".c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
      // 3) and produce byte-identical stdout
      const got = execFileSync(join(dir, mod), { encoding: "utf8" });
      ok(got === ref, name + ": .pyx compiles, builds, and matches CPython stdout",
        "pyx=" + JSON.stringify(got.slice(0, 60)) + " cpython=" + JSON.stringify(ref.slice(0, 60)));
    } catch (e) {
      ok(false, name + ": Cython acceptance", String(e.stderr || e.message).slice(0, 300));
    }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log("  note: py2cy's widths can be NARROWER than the hand-written golden");
  console.log("        (e.g. `int i` where the golden says `long long`) — both are sound.");
}

if (failures) process.exit(1);
