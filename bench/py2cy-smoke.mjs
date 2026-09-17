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
// `x` is carried by try/except (`int(input())` vs `0`) — its whole life is
// unprovable, so it must NOT be declared (the old `cython.int` was a
// miscompile: a huge input wrapped, or OverflowErrored into the wrong arm)
ok(!/cython\.declare\([^)]*\bx\s*=/.test(unprovable.text), "a try/except-carried value is NOT declared");
ok(unprovable.refusals.some((r) => /`x`/.test(r.reason)), "the try/except value is refused by name", JSON.stringify(unprovable.refusals));
ok(/cython\.declare\([^)]*\bi\s*=\s*cython\.int\b/.test(unprovable.text), "the provable counter in the same program IS declared");

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
ok(/cdef\s+int\s+h\b/.test(shortLoop.text), "range(2) proves h → `cdef int h`", shortLoop.text);
ok(!/cdef\s+long long\s+h/.test(shortLoop.text), "the short loop is NOT widened to long long");
const hDecl = shortLoop.decls.find((d) => d.name === "h");
const iDecl = shortLoop.decls.find((d) => d.name === "i");
// unrolling is exact per iteration, but the DECLARED range must cover the
// whole life: the entry value 0 AND every iteration (the last iteration
// alone, [1,1], would omit the initial 0 — an unsound proof)
ok(hDecl && /\[0,1\]/.test(hDecl.ty), "h's proved range spans the entry and all iterations [0,1]", hDecl && hDecl.ty);
ok(hDecl && /intermediate/.test(hDecl.why), "h's evidence names the intermediate width", hDecl && hDecl.why);
ok(iDecl && /counted-loop counter/.test(iDecl.why), "i's evidence says it is the counted-loop counter", iDecl && iDecl.why);
ok(shortLoop.decls.every((d) => d.why && d.why !== "proved by the flow analysis"), "every declaration carries specific evidence, not the old canned text");
const longLoop = annotate("h = 0\nfor i in range(100000):\n    h = (h * 31 + i) % 1000000007\nprint(h)\n", { mode: "pyx" });
ok(/cdef\s+long long\s+h/.test(longLoop.text), "a long loop keeps the [0,m-1] invariant (long long) — no overflow-by-unrolling");

// ── Float → double: CPython-identical semantics ───────────────
// A finite float under + - * / % (nonzero divisor) is exactly a C double
// (same IEEE-754 round-to-nearest; ZeroDivisionError on both sides), so it
// earns `cdef double`. Everything else float-shaped is refused.
console.log("\nfloat tier: proved finite doubles");
const flCode = "h = 0\nfor i in range(2000000):\n    h = (h * 31.4159 + i) % 1000000007\nprint(h)\n";
const fl = annotate(flCode, { mode: "pyx" });
ok(/cdef\s+double\s+h/.test(fl.text), "float recurrence proves `cdef double h`", fl.text);
const flD = fl.decls.find((d) => d.name === "h");
ok(flD && /Float\[0,1000000007\]/.test(flD.ty), "h is Float[0,1000000007] (modulus-bounded)", flD && flD.ty);
ok(flD && /modulus bounds/.test(flD.why), "h's evidence names the modulus", flD && flD.why);
ok(fl.stats.refusals === 0, "no refusals on the float recurrence", JSON.stringify(fl.refusals));
ok(/cython\.declare\([^)]*\bh\s*=\s*cython\.double\b/.test(annotate(flCode, { mode: "pure" }).text), "pure mode declares h=cython.double");
const flSimple = annotate("x = 1.5\ny = x + 2\nprint(x, y)\n", { mode: "pyx" });
ok(/cdef\s+float\s+x/.test(flSimple.text) && /cdef\s+float\s+y/.test(flSimple.text), "binary32-exact literals (1.5, +2) prove `cdef float`");
const flNeg = annotate("y = -7.5 % -3.0\nprint(y)\n", { mode: "pyx" });
const flNegD = flNeg.decls.find((d) => d.name === "y");
ok(flNegD && /Float\[-3,0\]/.test(flNegD.ty), "negative modulus proves Float[-3,0]", flNegD && flNegD.ty);
// the refusal side: inf literals, **, //, zero division, truncation, bigint mixes
for (const [n, code] of [
  ["inf literal", "x = 1e1000\nprint(x)\n"],
  ["pow", "x = 2.0 ** 2\nprint(x)\n"],
  ["floor-div", "x = 5.5 // 2.0\nprint(x)\n"],
  ["zero divisor", "x = 1.5 / 0.0\nprint(x)\n"],
  ["truncation", "x = int(3.7)\nprint(x)\n"],
  ["bigint mix", "x = 2 ** 100 * 1.5\nprint(x)\n"],
]) {
  const r = annotate(code, { mode: "pyx" });
  ok(!/cdef\s+double\s+x/.test(r.text), n + ": no `cdef double` (refused, not guessed)", r.text.slice(0, 160));
}
// pure-mode float output stays valid, runnable Python (parse check)
const flTmp = mkdtempSync(join(tmpdir(), "py2cy-float-"));
writeFileSync(join(flTmp, "fl.py"), annotate(flCode, { mode: "pure" }).text);
try {
  execFileSync("python3", ["-m", "py_compile", join(flTmp, "fl.py")], { stdio: "pipe" });
  ok(true, "pure-mode float output parses as Python");
} catch (e) { ok(false, "pure-mode float output parses as Python", String(e.message).slice(0, 200)); }
try { rmSync(flTmp, { recursive: true, force: true }); } catch {}

// ── single precision (`cdef float`): only when provably identical ──
// A `cdef float` changes the arithmetic of every expression whose operands
// are all float/int (C promotes to double only when SOME operand is double),
// so exactness is a WHOLE-PROGRAM property: a name keeps its binary32 proof
// only if every binary32 operation involving it has an exact result.
console.log("\nsingle precision: proved-exact binary32 only");
const f32 = annotate("x = float(42)\nq = 7 / 2\nhalf = 0.5\nr = q + half\nprint(x, q, half, r)\n", { mode: "pyx" });
ok(/cdef\s+float\s+x\b/.test(f32.text) && /cdef\s+float\s+q\b/.test(f32.text), "small ints / dyadic literals / /2 prove `cdef float`", f32.text);
ok(/cdef\s+float\s+r\b/.test(f32.text), "an exact float+float result stays `cdef float`");
ok(f32.stats.refusals === 0, "no refusals on the exact single-precision shape");
ok(/cython\.declare\([^)]*\bq\s*=\s*cython\.float\b/.test(annotate("q = 7 / 2\nprint(q)\n", { mode: "pure" }).text), "pure mode declares q=cython.float");
const inexact = annotate("d = 0.1\nx = float(42)\nprint(d, x)\n", { mode: "pyx" });
ok(/cdef\s+double\s+d\b/.test(inexact.text) && /cdef\s+float\s+x\b/.test(inexact.text), "0.1 (53-bit significand) stays `cdef double`; the exact 42 is `cdef float`");
const hazard = annotate("x = 4097.0\ny = x * x\nprint(y)\n", { mode: "pyx" });
ok(!/cdef\s+float\s+x\b/.test(hazard.text), "THE HAZARD: 4097*4097 is not binary32-exact → x demoted to double (a float op prints 16785408, not 16785409)");
const exactProd = annotate("x = 3.0\ny = x * x\nprint(y)\n", { mode: "pyx" });
ok(/cdef\s+float\s+x\b/.test(exactProd.text), "an exact product (3*3) keeps `cdef float`");
ok(!/cdef\s+float\s+h\b/.test(fl.text), "the 1e9 float recurrence is NOT binary32 (must stay double)");

// ── augmented assign is the full binop, not the RHS ─────────────
// `s += v` means `s = s + v`: joining the target with the bare RHS
// under-approximates (`s += 100` ×3 is 300, not [0,100]) and can declare
// a wrapping C type. The exact and the overflowing shapes:
console.log("\naugmented assignment (soundness: s OP= v ≡ s = s OP v)");
const augExact = annotate("s = 0\nfor i in range(10):\n    s += i\nprint(s)\n", { mode: "pyx" });
const augExactD = augExact.decls.find((d) => d.name === "s");
// a declaration must cover the variable's WHOLE life, so the range is the
// entry value (0) unioned with every iteration — not the final value alone
ok(augExactD && /Int\[0,45\]/.test(augExactD.ty), "`s += i` ×10 declares the whole-life range Int[0,45] (entry 0 + iterations)", augExactD && augExactD.ty);
const augWrap = annotate("s = 0\nfor i in range(20):\n    s += 1000000000000000000\nprint(s)\n", { mode: "pyx" });
ok(!/cdef\s+long long\s+s/.test(augWrap.text), "aug-assign overflow is never a wrapping `long long`", augWrap.text.slice(0, 200));
ok(!/cdef\s+mpz_t\s+s/.test(augWrap.text), "an unrewritable `s += <huge>` is NOT declared mpz_t (no half-translated file)", augWrap.text.slice(0, 200));
ok(!/cdef extern from "gmp\.h"/.test(augWrap.text), "no GMP block is emitted for a refused bigint");
ok(augWrap.refusals.some((r) => /GMP FFI/.test(r.reason)), "the untranslatable bigint += is refused, not silently emitted");
const augBig = annotate("x = 2 ** 100\nfor i in range(3):\n    x += 5\nprint(x % 7)\n", { mode: "pyx" });
ok(/mpz_add_ui\(x, x, 5\)/.test(augBig.text) && augBig.stats.refusals === 0, "bigint `x += 5` rewrites to mpz_add_ui");

// ── integer division: floor (//) and int() truncation ─────────
// `//` is Python floor-division even for negatives (-7 // 2 is -4, not
// the C-truncation -3); int() truncates toward zero. Both are proved only
// with closed ranges; huge/zero cases stay refused.
console.log("\ninteger division: floor (//) and int() truncation");
const idiv = annotate("a = 7 // 2\nb = -7 // 2\nprint(a, b)\n", { mode: "pyx" });
const idivA = idiv.decls.find((d) => d.name === "a");
const idivB = idiv.decls.find((d) => d.name === "b");
ok(idivA && /Int\[3,3\]/.test(idivA.ty), "`7 // 2` proves Int[3,3]", idivA && idivA.ty);
ok(idivB && /Int\[-4,-4\]/.test(idivB.ty), "`-7 // 2` floors to Int[-4,-4] (not truncation)", idivB && idivB.ty);
ok(idiv.stats.refusals === 0, "no refusals on constant floor-division");
const idivR = annotate("s = 0\nfor i in range(5, 11):\n    s = s + i // 4\nprint(s)\n", { mode: "pyx" });
const idivS = idivR.decls.find((d) => d.name === "s");
ok(idivS && /Int\[0,9\]/.test(idivS.ty), "interval-divisor floor-division declares Int[0,9] (entry 0 + iterations)", idivS && idivS.ty);
const itrunc = annotate("x = int(7 / 2)\ny = int(-7 / 2)\nprint(x, y)\n", { mode: "pyx" });
const itruncX = itrunc.decls.find((d) => d.name === "x");
const itruncY = itrunc.decls.find((d) => d.name === "y");
ok(itruncX && /Int\[3,3\]/.test(itruncX.ty), "`int(7 / 2)` truncates to Int[3,3]", itruncX && itruncX.ty);
ok(itruncY && /Int\[-3,-3\]/.test(itruncY.ty), "`int(-7 / 2)` truncates toward zero to Int[-3,-3]", itruncY && itruncY.ty);
for (const [n, code] of [
  ["huge truncation", "x = int(1e300)\nprint(x)\n"],
  ["truncated zero-division", "x = int(7 / 0)\nprint(x)\n"],
]) {
  const r = annotate(code, { mode: "pyx" });
  ok(!/cdef\s+int\s+x\b/.test(r.text), n + ": no `cdef int` (refused, not guessed)", r.text.slice(0, 160));
}

// ── a huge-guarded counter takes the GMP tier (the learned translations) ──
// `while i < 10**55: i += 1` used to be "proved" Int[1,8] and typed `cdef
// int` — a wrapping guess. The guard now promotes `i` to BigInt, and every
// line touching it is translated (init, guard, increment) or it stays refused.
console.log("\nsoundness: a huge-guarded counter takes the GMP tier, never a narrow C type");
const grow = annotate("x = 2 ** 100\ni = 0\nwhile i < 1000000000000000000000000000000000000000000000000000000:\n    x = x * 3\n    i = i + 1\nprint(x % 1000000007)\n", { mode: "pyx" });
ok(/cdef\s+mpz_t\s+i\b/.test(grow.text), "the huge-guarded counter `i` is declared BigInt (not `cdef int`)", grow.text);
ok(/cdef\s+mpz_t\s+x/.test(grow.text), "the bignum `x` is still proved");
ok(/mpz_set_ui\(i, 0\);/.test(grow.text), "bigint init translates: `i = 0` → mpz_set_ui");
ok(/mpz_add_ui\(i, i, 1\);/.test(grow.text), "bigint increment translates: `i = i + 1` → mpz_add_ui");
ok(/mpz_set_str\(__py2cy_bound_\d+, b"1000000000000000000000000000000000000000000000000000000", 10\);/.test(grow.text), "the huge bound is materialized once via mpz_set_str");
ok(/while mpz_cmp\(i, __py2cy_bound_\d+\) < 0:/.test(grow.text), "the guard translates: `while i < K` → mpz_cmp");
ok(!grow.refusals.some((r) => /did not converge/.test(r.reason)), "no non-convergence refusal remains for the promoted counter", JSON.stringify(grow.refusals));
// an untranslatable use still blocks promotion (print(i) has no GMP binding)
const growPrint = annotate("i = 0\nwhile i < 1000000000000000000000000000000000000000000000000000000:\n    i = i + 1\nprint(i)\n", { mode: "pyx" });
ok(!/cdef\s+mpz_t\s+i\b/.test(growPrint.text), "`print(i)` of a bigint has no binding, so promotion is refused (no half-translated file)");
const wc = annotate("i = 0\nwhile i < 100:\n    i = i + 1\nprint(i)\n", { mode: "pyx" });
// the guard IS the proof: the head always satisfies i < 100, so the closed
// range is i ∈ [0,100] (the last increment exits the loop)
ok(/cdef\s+int\s+i\b/.test(wc.text), "`while i < 100: i += 1` proves i ∈ [0,100] via the guard → `cdef int i`", wc.text);
const wcD = wc.decls.find((d) => d.name === "i");
ok(wcD && /\[0,100\]/.test(wcD.ty), "the guard-derived bound is the exact [0,100]", wcD && wcD.ty);
const wcBig = annotate("i = 0\nwhile i < 10**55:\n    i = i + 1\nprint(i)\n", { mode: "pyx" });
ok(wcBig.decls.length === 0 && wcBig.refusals.some((r) => /did not converge/.test(r.reason)), "a bigint guard bound gives no i64 guard, so the counter is still refused (not a wrapping int)");
const wcDown = annotate("i = 5\nwhile i > 0:\n    i = i - 1\nprint(i)\n", { mode: "pyx" });
const downD = wcDown.decls.find((d) => d.name === "i");
ok(downD && /\[0,5\]/.test(downD.ty) && downD.why && /guard/.test(downD.why), "a descending guard `while i > 0` bounds i ∈ [0,5] (and says so)", downD && downD.ty + " :: " + (downD && downD.why));
// a counted for-loop's counter is bounded by range() and must still be typed
const counted = annotate("s = 0\nfor k in range(64):\n    s = s + k\nprint(s)\n", { mode: "pyx" });
ok(/cdef\s+\w+\s+k\b/.test(counted.text), "a counted for-loop counter is still declared (the widening did not over-refuse)");

// ── typed memoryviews for read-only int lists ────────────────────
// A homogeneous int list that is only iterated becomes a buffer + view;
// anything else (print/append/len/index/empty/reassign/huge) stays a list.
console.log("\ntyped memoryviews (read-only int lists)");
const mv = annotate(getExample("int-list").code, { mode: "pyx" });
ok(/from array import array/.test(mv.text), "the buffer import is emitted");
ok(/cdef\s+unsigned char\[:\]\s+arr/.test(mv.text), "int-list proves `cdef unsigned char[:] arr` (narrowest sound width for [1,9])");
ok(/arr = array\('B', \[3, 1, 4, 1, 5, 9, 2, 6\]\)/.test(mv.text), "construction rewrites to array('B', …)");
ok(/cdef\s+int\s+v\b/.test(mv.text), "the iteration variable is typed from the element range");
const mvGolden = getExample("int-list").golden || "";
ok(/unsigned char\[:\]/.test(mvGolden) && /array\(/.test(mvGolden), "the hand-written golden agrees on the memoryview shape");
const mvI8 = annotate("arr = [-5, 5]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+signed char\[:\]\s+arr/.test(mvI8.text) && /array\('b'/.test(mvI8.text), "signed i8 range → `signed char[:]` / 'b'");
const mvU16 = annotate("arr = [0, 60000]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+unsigned short\[:\]\s+arr/.test(mvU16.text) && /array\('H'/.test(mvU16.text), "u16 range → `unsigned short[:]` / 'H'");
const mvI16 = annotate("arr = [-300, 300]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+short\[:\]\s+arr/.test(mvI16.text) && /array\('h'/.test(mvI16.text), "signed i16 range → `short[:]` / 'h'");
const mvU32 = annotate("arr = [0, 4000000000]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+unsigned int\[:\]\s+arr/.test(mvU32.text), "u32 elements → `unsigned int[:]`");
const mvI64 = annotate("arr = [0, 5000000000]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+long long\[:\]\s+arr/.test(mvI64.text), "i64 elements → `long long[:]` (the 64-bit workhorse)");
const mvU64 = annotate("arr = [0, 18446744073709551615]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+unsigned long long\[:\]\s+arr/.test(mvU64.text) && /array\('Q'/.test(mvU64.text), "u64 elements → `unsigned long long[:]` / 'Q' (now reachable via u64 literals)");
const mvU128 = annotate("arr = [0, 340282366920938463463374607431768211456]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+list\s+arr/.test(mvU128.text) && !/=\s*array\(/.test(mvU128.text), "beyond u64 (u128): no view exists — stays `cdef list`");
for (const [n, code] of [
  ["huge elements", "arr = [0, 2 ** 100]\nfor v in arr:\n    print(v)\n"],
  ["print(arr)", "arr = [3, 1]\nfor v in arr:\n    print(v)\nprint(arr)\n"],
  ["append", "arr = [3, 1]\narr.append(4)\nfor v in arr:\n    print(v)\n"],
  ["len()", "arr = [3, 1]\nn = len(arr)\nfor v in arr:\n    print(v)\nprint(n)\n"],
  ["indexing", "arr = [3, 1]\nprint(arr[0])\nfor v in arr:\n    print(v)\n"],
  ["empty", "arr = []\nfor v in arr:\n    print(v)\n"],
  ["reassign", "arr = [3, 1]\narr = [4, 5]\nfor v in arr:\n    print(v)\n"],
]) {
  const r = annotate(code, { mode: "pyx" });
  ok(/cdef\s+list\s+arr/.test(r.text) && !/=\s*array\(/.test(r.text), n + ": stays `cdef list` (no view)", r.text.slice(0, 200));
}

// ── float32 memoryviews (array('f') + float[:]) ──────────────────
// A list earns a float view only when EVERY element is binary32-exact
// (else array('f') rounds it) and the list is only iterated. The loop
// variable carries the same dyadic proof, so the whole-program condition
// still applies to it.
console.log("\nfloat32 memoryviews (array('f') + float[:])");
const fv = annotate("arr = [0.5, 1.5, 2.5]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/from array import array/.test(fv.text), "float view emits the buffer import");
ok(/cdef\s+float\[:\]\s+arr/.test(fv.text), "an all-exact float list proves `cdef float[:] arr`", fv.text);
ok(/arr = array\('f', \[0\.5, 1\.5, 2\.5\]\)/.test(fv.text), "construction rewrites to array('f', …)");
ok(/cdef\s+float\s+v\b/.test(fv.text), "the loop variable is proved binary32-exact");
const fvBad = annotate("arr = [0.1, 1.5]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+list\s+arr/.test(fvBad.text) && !/array\('f'/.test(fvBad.text), "an inexact element (0.1) blocks the float view");
const fvMix = annotate("arr = [1, 2.5]\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+list\s+arr/.test(fvMix.text) && !/array\('f'/.test(fvMix.text), "a mixed int/float list is refused (1 would print 1.0)");
const fvIdx = annotate("arr = [0.5, 1.5]\nprint(arr[0])\nfor v in arr:\n    print(v)\n", { mode: "pyx" });
ok(/cdef\s+list\s+arr/.test(fvIdx.text), "indexing blocks the float view");
const fvHaz = annotate("arr = [4097.0, 4097.0]\nfor v in arr:\n    w = v * v\n    print(w)\n", { mode: "pyx" });
ok(/cdef\s+float\[:\]\s+arr/.test(fvHaz.text) && !/cdef\s+float\s+v\b/.test(fvHaz.text), "THE HAZARD: v*v inexact demotes the loop variable; the exact view stays float[:]");

// ── the u64 tier (a C machine word between `long long` and GMP) ──
// Values in (i64, u64] used to fall off the C cliff into heap GMP; now they
// stay a single register. Beyond u64 (or below i64) is still GMP.
console.log("\nthe u64 tier");
const u64lit = annotate("x = 10000000000000000000\nprint(x)\n", { mode: "pyx" });
ok(/cdef\s+unsigned long long\s+x\b/.test(u64lit.text), "a u64 literal proves `cdef unsigned long long x` (not GMP)", u64lit.text);
const u64pure = annotate("x = 10000000000000000000\nprint(x)\n", { mode: "pure" });
ok(/cython\.declare\(x=cython\.ulonglong\)/.test(u64pure.text), "pure mode spells it `cython.ulonglong`");
const u64arith = annotate("y = 4611686018427387904\nz = y + y + y\nprint(z)\n", { mode: "pyx" });
ok(/cdef\s+unsigned long long\s+z\b/.test(u64arith.text), "u64 arithmetic stays a C word (not GMP)");
// the partial sum `y + y` (2**63) wraps a signed long long, so y is
// refused — the old `cdef long long y` only printed correctly by a
// mod-2**64 coincidence on the unsigned target (signed UB otherwise)
ok(!/cdef\s+(long\s+long|int)\s+y\b/.test(u64arith.text), "the wrapping i64 partial-sum operand is refused, not a wrapping C type", u64arith.text.slice(0, 200));
ok(u64arith.refusals.some((r) => /cannot evaluate exactly/.test(r.reason)), "the refusal names the C-evaluation hazard", JSON.stringify(u64arith.refusals));
const u64wrap = annotate("y = 4611686018427387904\nprint(y + y)\n", { mode: "pyx" });
ok(!/cdef\s+(long\s+long|int)\s+y\b/.test(u64wrap.text), "print(y + y) at 2**63: y refused (C would print -9223372036854775808)", u64wrap.text);
const stillBig = annotate("x = 2 ** 100\nprint(x % 7)\n", { mode: "pyx" });
ok(/cdef\s+mpz_t\s+x/.test(stillBig.text), "2**100 is still GMP (beyond u64)");
const negBig = annotate("x = -9223372036854775809\nprint(x % 7)\n", { mode: "pyx" });
ok(/cdef\s+mpz_t\s+x/.test(negBig.text), "below-i64 stays GMP (no unsigned type can hold it)");
ok(/mpz_set_str\(x, b"-9223372036854775809", 10\);/.test(negBig.text), "negative bigint literals translate via mpz_set_str (not verbatim)");

// ── a BigInt the GMP rewriter cannot lower must NOT be declared mpz_t ──
// A general accumulator (`value = value*base + digit`) has no GMP statement
// shape. Declaring it mpz_t used to emit a `.pyx` that does not compile
// (`Cannot convert 'mpz_t' to Python object` beside the verbatim line). It
// is now demoted to an honest refusal so the output stays valid Cython.
console.log("\nbigint: declared only when the GMP FFI can express every use");
const bigAcc = annotate("base = 10\ndigits = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]\nvalue = 0\nfor i in range(20):\n    value = value * base + digits[i]\nprint(value)\n", { mode: "pyx" });
ok(!/cdef\s+mpz_t\s+value/.test(bigAcc.text), "an unrewritable bigint accumulator is NOT declared `cdef mpz_t`", bigAcc.text);
ok(!/mpz_init\(value\)/.test(bigAcc.text), "no GMP init/clear is emitted for it");
ok(bigAcc.refusals.some((r) => /GMP FFI/.test(r.reason)), "the demotion is reported as a GMP-expressibility refusal", JSON.stringify(bigAcc.refusals));
ok(!bigAcc.refusals.some((r) => /type not provable/.test(r.reason)), "the reason is the GMP gap, not a generic 'type not provable'");
ok(/mpz_ui_pow_ui\(x, 2, 100\);/.test(annotate(getExample("bignum_mul").code, { mode: "pyx" }).text), "bignum_mul is still fully lowered to GMP");
// function scope is gated too: the old code declared `cdef mpz_t` in the
// def while leaving `y = x * 3 + 1` / `print(y % 7)` / `return y` verbatim
// (`Cannot convert Python object to 'mpz_t'`). Uncovered function bigints
// are demoted with a refusal that names the function.
const funcBig = annotate("def f():\n    x = 2 ** 100\n    y = x * 3 + 1\n    print(y % 7)\n    return y\nprint(f())\n", { mode: "pyx" });
ok(!/cdef\s+mpz_t/.test(funcBig.text), "an unrewritable function-local bigint is NOT declared `cdef mpz_t`", funcBig.text);
ok(funcBig.refusals.some((r) => /`f\(\)`/.test(r.reason) && /GMP FFI/.test(r.reason)), "the refusal names the function and the GMP gap", JSON.stringify(funcBig.refusals));
// ...while a fully rewritable function body keeps the tier
const funcBigOk = annotate("def f():\n    x = 2 ** 100\n    print(x % 7)\nf()\n", { mode: "pyx" });
ok(/cdef\s+mpz_t\s+x/.test(funcBigOk.text) && funcBigOk.stats.refusals === 0, "a fully rewritable function body keeps `cdef mpz_t` (0 refusals)", funcBigOk.text);
// opaque blocks are emitted verbatim and never rewritten inside, so any
// mention of a bigint there demotes (the old code kept the declaration
// and emitted an uncompilable file)
const opaqueBig = annotate("x = 2 ** 100\ntry:\n    print(x % 7)\nexcept:\n    print(0)\n", { mode: "pyx" });
ok(!/cdef\s+mpz_t\s+x/.test(opaqueBig.text), "a bigint mentioned inside try/except is demoted (opaque ⇒ verbatim)", opaqueBig.text);
ok(opaqueBig.refusals.some((r) => /GMP FFI/.test(r.reason)), "the opaque demotion is reported as a GMP-expressibility refusal");
// shadowing is conservative: the renderer rewrites by bare name, so a
// shadowing int local poisons the name everywhere (else its `x = 1` would
// be mpz_set_ui'd against a C int)
const shadowBig = annotate("x = 2 ** 100\nprint(x % 7)\ndef f():\n    x = 1\n", { mode: "pyx" });
ok(!/cdef\s+mpz_t/.test(shadowBig.text), "a shadowed bigint name is demoted everywhere", shadowBig.text);
ok(shadowBig.decls.some((d) => d.name === "x" && /Int\[1,1\]/.test(d.ty)), "the shadowing int local itself stays typed", JSON.stringify(shadowBig.decls));
// a print that does not touch a bigint records no refusal (the old code
// blamed every print in a bigint file on the missing GMP output binding)
const printPlain = annotate("x = 2 ** 100\nprint(x % 7)\nprint(\"done\")\n", { mode: "pyx" });
ok(/cdef\s+mpz_t\s+x/.test(printPlain.text) && printPlain.refusals.length === 0, "printing a non-bigint beside a bigint records no refusal", JSON.stringify(printPlain.refusals));
// bools are never C ints: `True` prints as "True", not "1"
console.log("\nbools are untypable (print/str would diverge)");
for (const [tag, code] of [
  ["literal", "flag = True\nprint(flag)\n"],
  ["not", "y = not 0\nprint(y)\n"],
  ["comparison", "c = 3 < 5\nprint(c)\n"],
]) {
  const r = annotate(code, { mode: "pyx" });
  ok(!/cdef\s+/.test(r.text.split("Generated by py2cy")[1] || r.text), tag + ": no C declaration for a bool", r.text);
  ok(r.refusals.some((x) => /bool/.test(x.reason)), tag + ": the refusal names the bool hazard", JSON.stringify(r.refusals));
}
// straight-line redefinition joins: the declared type covers every value
// ever assigned, not just the last write (`x = 3e9; x = 1` wrapped to
// -1294967296 under the old overwrite rule)
const redef = annotate("x = 3000000000\nprint(x)\nx = 1\nprint(x)\n", { mode: "pyx" });
const redefD = redef.decls.find((d) => d.name === "x");
ok(redefD && /Int\[1,3000000000\]/.test(redefD.ty), "redefinition declares the whole-life range Int[1,3000000000]", redefD && redefD.ty);
ok(/cdef\s+unsigned int\s+x\b/.test(redef.text), "...which still fits a C type (unsigned int), so it stays typed", redef.text);
const redefMixed = annotate("x = 5\nx = \"hi\"\nprint(x)\n", { mode: "pyx" });
ok(!redefMixed.decls.some((d) => d.name === "x"), "mixed-type redefinition is refused, not guessed", JSON.stringify(redefMixed.decls));
// the base-n example's accumulator must be typed and cover its initial 0
const baseN = annotate(getExample("base-n-parse").code, { mode: "pyx" });
const baseV = baseN.decls.find((d) => d.name === "value");
ok(baseV && /\[0,/.test(baseV.ty), "base-n-parse: the accumulator range includes the initial 0", baseV && baseV.ty);
ok(baseN.refusals.length === 0, "base-n-parse: every local is typed (0 refusals)", JSON.stringify(baseN.refusals));

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
  const cases = ["rolling_hash", "bignum_mul", "def-rolling-hash", "int-list", "base-n-parse", "sum_squares", "fizzbuzz", "while-count", "builtins", "refusals"];
  for (const name of cases) {
    // `ex_` prefix: the module name must not collide with the stdlib
    // (`builtins.pyx` chokes Cython's own `builtins` import machinery)
    const mod = "ex_" + name.replace(/-/g, "_");
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
  // a terminating bigint counter exercises the new guard translations at
  // runtime (doubling from 2**100 to 10**55 takes ~80 iterations): the temp
  // bound, mpz_cmp, set_ui/add_ui must all work, with stdout parity.
  try {
    const dblCode = "i = 2 ** 100\nwhile i < 1000000000000000000000000000000000000000000000000000000:\n    i = i * 2\nprint(i % 1000000007)\n";
    const ref = execFileSync("python3", ["-c", dblCode], { encoding: "utf8" });
    const pyx = annotate(dblCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "bigdbl.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "bigdbl.pyx", "-o", "bigdbl.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "bigdbl", "bigdbl.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "bigdbl"), { encoding: "utf8" });
    ok(got === ref, "bigint counter (huge guard): .pyx compiles, builds, and matches CPython stdout",
      "pyx=" + JSON.stringify(got.slice(0, 60)) + " cpython=" + JSON.stringify(ref.slice(0, 60)));
  } catch (e) {
    ok(false, "bigint counter (huge guard): Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // float recurrence: the new double tier must match CPython bit-for-bit
  // (same binary64 values ⇒ same repr ⇒ byte-identical stdout).
  try {
    const ref = execFileSync("python3", ["-c", flCode], { encoding: "utf8" });
    const pyx = annotate(flCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "floatrec.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "floatrec.pyx", "-o", "floatrec.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "floatrec", "floatrec.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "floatrec"), { encoding: "utf8" });
    ok(got === ref, "float recurrence: .pyx compiles, builds, and matches CPython stdout",
      "pyx=" + JSON.stringify(got.slice(0, 60)) + " cpython=" + JSON.stringify(ref.slice(0, 60)));
  } catch (e) {
    ok(false, "float recurrence: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // integer division at runtime: floor semantics (incl. negatives) and
  // truncation must match CPython exactly in the compiled binary.
  try {
    const idivCode = "a = 7 // 2\nb = -7 // 2\ns = 0\nfor i in range(5, 11):\n    s = s + i // 4\nprint(a, b, s)\n";
    const ref = execFileSync("python3", ["-c", idivCode], { encoding: "utf8" });
    const pyx = annotate(idivCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "intdiv.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "intdiv.pyx", "-o", "intdiv.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "intdiv", "intdiv.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "intdiv"), { encoding: "utf8" });
    ok(got === ref, "integer division: .pyx compiles, builds, and matches CPython stdout",
      "pyx=" + JSON.stringify(got.slice(0, 60)) + " cpython=" + JSON.stringify(ref.slice(0, 60)));
  } catch (e) {
    ok(false, "integer division: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // single precision at runtime: an exact `cdef float` program must print
  // what CPython's binary64 prints, and the 4097*4097 hazard must NOT be
  // emitted as float (it would print 16785408 instead of 16785409).
  try {
    const f32Code = "x = float(42)\nq = 7 / 2\nhalf = 0.5\nr = q + half\nprint(x, q, half, r)\n";
    const ref = execFileSync("python3", ["-c", f32Code], { encoding: "utf8" });
    const pyx = annotate(f32Code, { mode: "pyx" }).text;
    writeFileSync(join(dir, "f32.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "f32.pyx", "-o", "f32.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "f32", "f32.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "f32"), { encoding: "utf8" });
    ok(got === ref, "single precision: exact .pyx compiles, builds, and matches CPython stdout",
      "pyx=" + JSON.stringify(got.slice(0, 60)) + " cpython=" + JSON.stringify(ref.slice(0, 60)));
    const hazCode = "x = 4097.0\ny = x * x\nprint(y)\n";
    const hazRef = execFileSync("python3", ["-c", hazCode], { encoding: "utf8" });
    const hazPyx = annotate(hazCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "f32haz.pyx"), hazPyx);
    execFileSync("cython", ["--embed", "-3", "f32haz.pyx", "-o", "f32haz.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "f32haz", "f32haz.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const hazGot = execFileSync(join(dir, "f32haz"), { encoding: "utf8" });
    ok(hazGot === hazRef, "single-precision hazard: 4097*4097 still matches CPython (demoted to double)",
      "pyx=" + JSON.stringify(hazGot) + " cpython=" + JSON.stringify(hazRef));
  } catch (e) {
    ok(false, "single precision: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // branch join soundness: the arms must be JOINED, not overwritten
  try {
    const brCode = "c = True\nif c:\n    x = 5000000000\nelse:\n    x = 1\nprint(x)\n";
    const ref = execFileSync("python3", ["-c", brCode], { encoding: "utf8" });
    const pyx = annotate(brCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "branch.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "branch.pyx", "-o", "branch.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "branch", "branch.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "branch"), { encoding: "utf8" });
    ok(got === ref, "branch arms are JOINED (5e9 in one arm cannot hide behind 1 in the other)",
      "pyx=" + JSON.stringify(got) + " cpython=" + JSON.stringify(ref));
  } catch (e) {
    ok(false, "branch join soundness: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // the u64 tier at runtime (a machine word, not GMP)
  try {
    const u64Code = "x = 10000000000000000000\nprint(x % 1000000007)\nprint(x + 1)\n";
    const ref = execFileSync("python3", ["-c", u64Code], { encoding: "utf8" });
    const pyx = annotate(u64Code, { mode: "pyx" }).text;
    writeFileSync(join(dir, "u64word.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "u64word.pyx", "-o", "u64word.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "u64word", "u64word.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "u64word"), { encoding: "utf8" });
    ok(got === ref, "u64 scalar: .pyx compiles, builds, and matches CPython stdout");
  } catch (e) {
    ok(false, "u64 scalar: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // a signed narrow view at runtime (signedness is where dtype bugs hide)
  try {
    const sigCode = "arr = [-300, 300, -1]\nfor v in arr:\n    print(v)\n";
    const ref = execFileSync("python3", ["-c", sigCode], { encoding: "utf8" });
    const pyx = annotate(sigCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "signarrow.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "signarrow.pyx", "-o", "signarrow.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "signarrow", "signarrow.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "signarrow"), { encoding: "utf8" });
    ok(got === ref, "signed narrow view (short[:]): .pyx compiles, builds, and matches CPython stdout");
  } catch (e) {
    ok(false, "signed narrow view: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // float32 memoryview at runtime: array('f') + float[:] must print exactly
  // what CPython's list-of-doubles prints, and the inexact v*v hazard must
  // still match (the view is exact, the loop variable is demoted to double).
  try {
    const fvCode = "arr = [0.5, 1.5, 2.5]\nfor v in arr:\n    print(v)\n";
    const ref = execFileSync("python3", ["-c", fvCode], { encoding: "utf8" });
    const pyx = annotate(fvCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "f32view.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "f32view.pyx", "-o", "f32view.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "f32view", "f32view.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "f32view"), { encoding: "utf8" });
    ok(got === ref, "float32 view: .pyx compiles, builds, and matches CPython stdout",
      "pyx=" + JSON.stringify(got) + " cpython=" + JSON.stringify(ref));
    const fvHazCode = "arr = [4097.0, 4097.0]\nfor v in arr:\n    w = v * v\n    print(w)\n";
    const hazRef = execFileSync("python3", ["-c", fvHazCode], { encoding: "utf8" });
    const hazPyx = annotate(fvHazCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "f32vhaz.pyx"), hazPyx);
    execFileSync("cython", ["--embed", "-3", "f32vhaz.pyx", "-o", "f32vhaz.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "f32vhaz", "f32vhaz.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const hazGot = execFileSync(join(dir, "f32vhaz"), { encoding: "utf8" });
    ok(hazGot === hazRef, "float32 view hazard: v*v stays CPython-exact (loop var demoted to double)",
      "pyx=" + JSON.stringify(hazGot) + " cpython=" + JSON.stringify(hazRef));
  } catch (e) {
    ok(false, "float32 view: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  try {
    const hugeCode = "x = 2 ** 100\ni = 0\nwhile i < 1000000000000000000000000000000000000000000000000000000:\n    x = x * 3\n    i = i + 1\nprint(x % 1000000007)\n";
    const pyx = annotate(hugeCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "bigcounter.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "bigcounter.pyx", "-o", "bigcounter.c"], { cwd: dir, stdio: "pipe" });
    ok(true, "huge-guarded bigint counter: .pyx cythonizes (the previously non-compiling shape)");
  } catch (e) {
    ok(false, "huge-guarded bigint counter: cythonize", String(e.stderr || e.message).slice(0, 300));
  }
  // the demoted bigint accumulator must also cythonize (the old mpz_t output
  // did not) AND still match CPython stdout (it stays exact Python)
  try {
    const accCode = "base = 10\ndigits = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]\nvalue = 0\nfor i in range(20):\n    value = value * base + digits[i]\nprint(value)\n";
    const ref = execFileSync("python3", ["-c", accCode], { encoding: "utf8" });
    const pyx = annotate(accCode, { mode: "pyx" }).text;
    writeFileSync(join(dir, "bigacc.pyx"), pyx);
    execFileSync("cython", ["--embed", "-3", "bigacc.pyx", "-o", "bigacc.c"], { cwd: dir, stdio: "pipe" });
    execFileSync("cc", ["-O2", "-o", "bigacc", "bigacc.c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
    const got = execFileSync(join(dir, "bigacc"), { encoding: "utf8" });
    ok(got === ref, "demoted bigint accumulator: .pyx compiles and matches CPython stdout");
  } catch (e) {
    ok(false, "demoted bigint accumulator: Cython acceptance", String(e.stderr || e.message).slice(0, 300));
  }
  // the newly gated shapes must all compile AND match CPython stdout:
  // demoted function-local, covered function-local (real GMP in a def),
  // opaque-try demotion, and shadow demotion
  for (const [tag, code] of [
    ["funcbig_demoted", "def f():\n    x = 2 ** 100\n    y = x * 3 + 1\n    print(y % 7)\n    return y\nprint(f())\n"],
    ["funcbig_typed", "def f():\n    x = 2 ** 100\n    print(x % 7)\nf()\n"],
    ["opaquebig", "x = 2 ** 100\ntry:\n    print(x % 7)\nexcept:\n    print(0)\n"],
    ["shadowbig", "x = 2 ** 100\nprint(x % 7)\ndef f():\n    x = 1\n"],
    ["u64wrap", "y = 4611686018427387904\nprint(y + y)\n"],
    ["csubwrap", "def f():\n    return 0\ntotal = f()\ni = 4000000000\ntotal = total + i * i\nprint(total)\n"],
    ["defsitewrap", "i = 3000000000\nj = 3000000000\ns = i + j\nprint(s)\n"],
    ["tryexcept", "try:\n    x = int(input())\nexcept Exception:\n    x = 0\nprint(x)\n"],
    ["redefw", "x = 3000000000\nprint(x)\nx = 1\nprint(x)\n"],
  ]) {
    try {
      const ref = execFileSync("python3", ["-c", code], { encoding: "utf8" });
      const pyx = annotate(code, { mode: "pyx" }).text;
      writeFileSync(join(dir, tag + ".pyx"), pyx);
      execFileSync("cython", ["--embed", "-3", tag + ".pyx", "-o", tag + ".c"], { cwd: dir, stdio: "pipe" });
      execFileSync("cc", ["-O2", "-o", tag, tag + ".c", ...inc, ...ld, "-lgmp"], { cwd: dir, stdio: "pipe" });
      const got = execFileSync(join(dir, tag), { encoding: "utf8" });
      ok(got === ref, tag + ": .pyx compiles and matches CPython stdout");
    } catch (e) {
      ok(false, tag + ": Cython acceptance", String(e.stderr || e.message).slice(0, 300));
    }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log("  note: py2cy's widths can be NARROWER than the hand-written golden");
  console.log("        (e.g. `int i` where the golden says `long long`) — both are sound.");
}

if (failures) process.exit(1);
