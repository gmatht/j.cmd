// auto_cython web GUI — the example corpus.
//
// Every entry is a Python source plus (where a hand-written golden
// exists) the typed Cython that a human wrote for it. AUTO_CYTHON.md §2
// calls these the acceptance oracle: `py-sh-go/profile_example/bench/
// cython/{rolling_hash,bignum,io}_typed.pyx` are exactly what the
// annotator must learn to emit.
//
// `golden` is the hand-written .pyx (from otranspiler-frontends, GPL-3)
// shown side by side with py2cy's generated output, so the page makes
// the claim checkable rather than asserted.
//
// ─── the python-O4 bench appendix (2026-09) ──────────────────────────
//
// Everything from `pyo4-bench-*` onward is vendored from
// `bash-o4/bench/py/` (sh2loop, GPL-3) — the eight problems the
// python-O4 benchmark drives (`bench/README-py.md`). They are vendored
// rather than imported because the page is deployed to GitHub Pages and
// the sibling checkout does not exist there; keep them in sync by hand.
//
// TWO caveats, recorded so the corpus is not overclaimed:
//
//   1. These have NO hand-written `.pyx` golden. Only three goldens exist
//      upstream (`profile_example/bench/cython/{rolling_hash,bignum,io}
//      _typed.pyx`) and the first two already back `rolling_hash` /
//      `bignum_mul`. So for these entries the panel shows the generated
//      output only — the page renders "no hand-written golden" and that
//      is accurate, not a gap to hide.
//
//   2. Their oracle is a C program, not Cython. `bench/c/*.c` is the
//      byte-exact reference the benchmark's agreement gate uses, and
//      several sources say so explicitly ("Matches bench/c/squaresmap.c
//      exactly"). Where that counterpart exists it is shown as `agrees`,
//      and the `expected` values below were taken from RUNNING py2cy on
//      the source, not written by hand.
//
// `sqrt1337` is one of the eight bench problems and the only one the
// frontend does not support — `bench-py.py` marks it `unsupported` and
// reports SKIP rather than FAIL (py-sh-go v1 has no string containment).
// py2cy refuses its `if "1337" in str(i * i)` line too, so it is
// included as a picture of where the boundary sits — not as a claim
// that anything was rescued or preserved.

export const EXAMPLES = [
  {
    name: "rolling_hash",
    desc: "the canonical typed-`.pyx` shape — a counted loop and a modulo recurrence. py2cy proves h ∈ [0, 10^9) but the intermediate h*31 needs 64 bits, so h is `long long` (the intermediate-width proof).",
    expected: "long long h, int i",
    code: `# bench/rolling_hash.py — a non-foldable modulo recurrence.
# CPython dispatches every op; the typed C loop is a few instructions.
h = 0
for i in range(2000000):
    h = (h * 31 + i) % 1000000007
print(h)
`,
    golden: `# cython: language_level=3, boundscheck=False, wraparound=False, cdivision=True
# Hand-written typed Cython for bench/rolling_hash.py.
def main():
    cdef long long i
    cdef long long h = 0
    for i in range(2000000):
        h = (h * 31 + i) % 1000000007
    print(h)
main()
`,
  },
  {
    name: "bignum_mul",
    desc: "bigint: 2**100 is far beyond 64 bits. Cython has no native big-int, so py2cy proves the bigint tier and emits the GMP FFI block plus the mpz_* rewrites — what bignum_typed.pyx does by hand.",
    expected: "GMP FFI: cdef mpz_t x, mpz_ui_pow_ui / mpz_mul_ui / mpz_fdiv_ui",
    code: `# bench/bignum_mul.py — values far beyond 64 bits.
# Both sides are exact; the question is speed and memory.
x = 2 ** 100
i = 0
while i < 100000:
    x = x * 3
    i = i + 1
print(x % 1000000007)
`,
    golden: `# cython: language_level=3
# Hand-written typed Cython for bench/bignum_mul.py. Cython has NO native
# big-int, so the user must bind GMP by hand (what py-sh-go emits
# automatically for a \`2 ** 100\` literal).
from libc.stdio cimport FILE, stdout, printf
cdef extern from "gmp.h":
    ctypedef struct __mpz_struct:
        int _mp_alloc
        int _mp_size
        void *_mp_d
    ctypedef __mpz_struct mpz_t[1]
    void mpz_init(mpz_t)
    void mpz_clear(mpz_t)
    void mpz_ui_pow_ui(mpz_t, unsigned long, unsigned long)
    void mpz_mul_ui(mpz_t, const mpz_t, unsigned long)
    unsigned long mpz_fdiv_ui(const mpz_t, unsigned long)
def main():
    cdef mpz_t x
    cdef long long i
    mpz_init(x)
    mpz_ui_pow_ui(x, 2, 100)
    for i in range(100000):
        mpz_mul_ui(x, x, 3)
    printf("%lu\\n", mpz_fdiv_ui(x, 1000000007))
    mpz_clear(x)
main()
`,
  },
  {
    name: "def-rolling-hash",
    desc: "the same proof inside a function — @cython.locals in pure-Python mode, `cdef` in .pyx. An unproved parameter (n) does not stop the proof of h: the loop counter is simply left as a Python object.",
    expected: "@cython.locals(h=cython.longlong) / cdef long long h",
    code: `def rolling_hash(n):
    h = 0
    for i in range(n):
        h = (h * 31 + i) % 1000000007
    return h

print(rolling_hash(2000000))
`,
  },
  {
    name: "sum_squares",
    desc: "a bounded loop plus a reduction. The loop counter is typed; the accumulator's range does not reach a fixpoint within the widening budget (there is no closed form), so it is honestly left a Python object — sound, just untyped.",
    expected: "typed counter; accumulator refused (sound)",
    code: `total = 0
for i in range(1000):
    total = total + i * i
print(total)
`,
  },
  {
    name: "int-list",
    desc: "a proved int list that is only iterated — py2cy converts it to a buffer (`array`) + typed memoryview. The accumulator's range does not close (no reduction bound), so it stays a Python object — never guessed.",
    expected: "unsigned char[:] (u8) view; accumulator refused (sound)",
    code: `arr = [3, 1, 4, 1, 5, 9, 2, 6]
total = 0
for v in arr:
    total = total + v
print(total)
`,
    golden: `# cython: language_level=3, boundscheck=False, wraparound=False
# Hand-written typed Cython for the int-list shape: a homogeneous int list
# that is only iterated becomes a buffer + typed memoryview (no numpy —
# the stdlib array supplies the buffer).
from array import array
def main():
    cdef unsigned char[:] arr = array('B', [3, 1, 4, 1, 5, 9, 2, 6])
    cdef long long total = 0
    cdef int v
    for v in arr:
        total += v
    print(total)
main()
`,
  },
  {
    name: "base-n-parse",
    desc: "a base-n integer parser: fold a digit list n = n*base + digit, then print the decimal value. Every local is typed — the radix, the digit list, and the accumulator. (A parser whose accumulator exceeds 64 bits has no GMP statement shape, so it is refused and left as exact Python rather than emitted as non-compiling Cython.)",
    expected: "typed base/digits/value; int accumulator",
    code: `# parse a base-n digit list and print the decimal value
base = 16
digits = [10, 15, 3, 8]
value = 0
for i in range(4):
    value = value * base + digits[i]
print(value)
`,
  },
  {
    name: "refusals",
    desc: "the honest half: try/except, dicts, comprehensions and method calls are NOT provable. py2cy leaves the source untouched there and lists each refusal — the output is still plain, correct Python (REFUSE > GUESS).",
    expected: "a populated refusal manifest",
    code: `import os

data = {}
try:
    x = int(input())
except Exception:
    x = 0

words = []
for i in range(3):
    words.append(str(i))

y = [i for i in range(3)]
print(len(data), x, words, y)
`,
  },
  {
    name: "fizzbuzz",
    desc: "a control-flow shape: if/elif/else inside a counted loop. The loop counter is typed; print() of a literal is fine; nothing is guessed.",
    expected: "typed counter, no refusals",
    code: `for i in range(1, 16):
    if i % 15 == 0:
        print("fizzbuzz")
    elif i % 3 == 0:
        print("fizz")
    elif i % 5 == 0:
        print("buzz")
    else:
        print(i)
`,
  },
  {
    name: "while-count",
    desc: "a while loop whose bound comes from the CONDITION, not range(): the guard `i < 100` bounds the loop head, so the counter is proved i ∈ [0,100] — a while counter is typed when its guard gives a closed i64 bound (REFUSE > GUESS for the rest).",
    expected: "guard-derived counter: Int[0,100]",
    code: `i = 0
while i < 100:
    i = i + 1
print(i)
`,
  },
  // ─── python-O4 bench appendix — see the header for provenance ──────
  {
    name: "pyo4-bench-hash",
    desc: "per-record integer mix, accumulator held mod 256. The modulus gives a closed bound [0,255] while the intermediate `s + a*31 + b*17` needs the wider intermediate — the same intermediate-width proof rolling_hash makes, in one line. No refusals.",
    expected: "0 refusals; `s` Int[0,255], `a`/`b`/`i`/`N` int",
    code: `# hash: per-record integer mix, accumulator kept mod 256.
N = 1000000
s = 0
for i in range(N):
    a = (i * 53) % 256
    b = (i * 89) % 256
    s = (s + a * 31 + b * 17) % 256
print(s)
`,
    agrees: `/* handwritten reference: per-record integer mix, accumulator
   kept mod 256 (bash-faithful). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  long long n = atoll(argv[1]);
  long long s = 0;
  for (long long i = 0; i < n; i++) {
    long long a = (i * 53) % 256;
    long long b = (i * 89) % 256;
    s = (s + a * 31 + b * 17) % 256;
  }
  printf("%lld\\n", s);
  return 0;
}
`,
  },
  {
    name: "pyo4-bench-sumred",
    desc: "a mod-2^32 reduce that is overflow-exact on every side. Both the accumulator and its intermediate are bounded by the outer modulus, so `s` is proved [0, 2^32) and typed `long long` — wide enough for the sum but not an arbitrary bigint. No refusals; this is the benchmark's headline GPU row.",
    expected: "0 refusals; `s` long long, Int[0,4294967295]",
    code: `# sumred: mod-2^32 accumulate of i*i (overflow-exact on every side).
N = 1000000000
s = 0
for i in range(N):
    s = (s + (i * i) % 4294967296) % 4294967296
print(s)
`,
    agrees: `/* handwritten reference: mod-2^32 accumulate of i*i
   (overflow-exact on every side — the u32 wrap is the point). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  unsigned long long n = strtoull(argv[1], 0, 10);
  unsigned long long s = 0;
  for (unsigned long long i = 0; i < n; i++)
    s = (s + ((i * i) & 0xFFFFFFFFull)) & 0xFFFFFFFFull;
  printf("%llu\\n", s);
  return 0;
}
`,
  },
  {
    name: "pyo4-bench-squares-map",
    desc: "materialise `a[i]=i*i`, then a mod-2^32 checksum — the CPU counterpart to a GPU map+readback (identical memory traffic). py2cy proves `a` an int list and `s` long long, but the `a.append(...)` method call is NOT lowered: one refusal, left as plain Python. That refusal is the honest boundary — the affine-store rewrite belongs to python-O4's CUDA candidacy view, not the annotator.",
    expected: "1 refusal (a.append); `s` long long, `a` list",
    code: `# squares-map: materialise a[i]=i*i, then a mod-2^32 checksum (the fair
# CPU counterpart to a GPU map+readback: same memory traffic). Matches
# bench/c/squaresmap.c exactly (unsigned wrap per element, u32 sum).
#
# \`append\` is the CPython-valid way to build a growing list (lists do not
# auto-grow). python-O4 rewrites a counted loop's single append into the
# affine indexed store \`a[i] = v\` for the CUDA candidacy view, so this
# SAME source drives every leg (see docs/PYTHON-O4.md).
N = 100000000
a = []
for i in range(N):
    a.append(i * i)
s = 0
for i in range(N):
    s = (s + a[i]) % 4294967296
print(s)
`,
    agrees: `/* handwritten reference: materialise out[i]=i*i, then mod-2^32 checksum
   (the fair CPU counterpart to a GPU map+readback: same memory traffic). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  unsigned long long n = strtoull(argv[1], 0, 10);
  long long *out = malloc(n * sizeof *out);
  if (!out) { fprintf(stderr, "oom\\n"); return 1; }
  for (unsigned long long i = 0; i < n; i++) out[i] = (long long)(i * i);
  unsigned long long s = 0;
  for (unsigned long long i = 0; i < n; i++)
    s = (s + (unsigned long long)out[i]) & 0xFFFFFFFFull;
  printf("%llu\\n", s);
  free(out);
  return 0;
}
`,
  },
  {
    name: "pyo4-bench-addsum",
    desc: "scalar accumulation — the simplest shape in the corpus, and the one that shows a REFUSAL rather than a guess. The counter is typed from `range(N)`, but the accumulator's range never reaches a fixpoint (the loop runs 10^6 times, far past the widening budget), so `s` is honestly left a Python object. Contrast pyo4-bench-addsum32, where a smaller N makes the same source provable.",
    expected: "1 refusal (`s` did not converge); `i`/`N` typed",
    code: `# addsum: scalar accumulation (native i64). The addsum32 problem reuses
# this exact program with a smaller N (int32-exact sum).
N = 1000000
s = 0
for i in range(N):
    s = s + i
print(s)
`,
    agrees: `/* handwritten reference: scalar i64 accumulation (bash-faithful). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  long long n = atoll(argv[1]);
  long long s = 0;
  for (long long i = 0; i < n; i++) s += i;
  printf("%lld\\n", s);
  return 0;
}
`,
  },
  {
    name: "pyo4-tier-overflow-replay",
    desc: "the tiered-overflow case, and the sharpest in the corpus: `s` starts at 1 and adds 4*10^18 five times, so the value leaves i64 entirely. py2cy proves BigInt, emits the full GMP FFI block and `cdef mpz_t s` — then REFUSES two things rather than guessing: the `s = s + 4000000000000000000` assignment (not expressible as a `mpz_*_ui` call) and `print(s)` (needs a GMP output binding). So the declarations are right while the body stays Python — the sharpest illustration of REFUSE > GUESS. The subtlety the source names: a replay that started from a stale mpz slot — never written while the i64 mirror was authoritative — would print 2e19 instead of the +1-exact 20000000000000000001.",
    expected: "2 refusals (bigint add + bigint print); BigInt proved, GMP FFI + cdef mpz_t s emitted",
    code: `# t101_tier_overflow_replay: forces the i64 tier to overflow inside a
# speculative fast arm, then the exact GMP replay. The tiered var's ENTRY
# value is nonzero, so a replay that started from the stale mpz slot
# (never written while the mirror was authoritative) would print 2e19
# instead of the +1-exact 20000000000000000001.
s = 1
i = 0
while i < 5:
    s = s + 4000000000000000000
    i = i + 1
print(s)
`,
  },
  {
    name: "pyo4-additive-native",
    desc: "the guard against over-eager tiering: the same accumulate shape as the entry above, but provably inside the exact domain (3 x 1000 = 3000). It must STAY on the native int path — if `s` were promoted to bigint here, the tier guard would be firing on every loop-carried accumulator and the whole native path would be dead. Pairs with pyo4-tier-overflow-replay as the two sides of the tier decision.",
    expected: "0 refusals; `s` Int[3000,3000] int — NO bigint",
    code: `# t100_additive_native: the same shape but provably inside the exact
# domain (3 * 1000), so it must STAY on the native int path — the guard
# must not force bigint for every loop-carried accumulator.
s = 0
for i in range(3):
    s = s + 1000
print(s)
`,
  },
  {
    name: "pyo4-sqrt1337-refusal",
    desc: "one of the eight python-O4 bench problems, and the only one the frontend doesn't support: `bench-py.py` reports it as SKIP (py-sh-go v1 has no string containment). py2cy refuses the `if \"1337\" in str(i * i)` line for the same reason (`trailing tokens: in str ( i * i )`), so it is a useful picture of where the boundary sits.",
    expected: "1 refusal: `in str(...)` not lowered (known v1 gap)",
    code: `# sqrt1337: i in 1..10000 with "1337" in i*i.
for i in range(1, 10001):
    if "1337" in str(i * i):
        print(i)
`,
  },
  // ─── feature coverage: one example per py2cy tier ──────────────
  // The entries above prove the classic tiers; these pin the rest of the
  // annotator's surface, including the newest tiers. Each `expected` was
  // taken from RUNNING py2cy (not written by hand), and none has a
  // hand-written golden — like the pyo4 appendix, the generated output is
  // the claim and the refusal manifest keeps it honest.
  {
    name: "float-recurrence",
    desc: "the Float tier: a finite float under + and % with a nonzero modulus is exactly a C double (same IEEE-754 round-to-nearest as CPython). py2cy proves h ∈ [0, 10^9) and emits `cdef double h` — the float analogue of rolling_hash's intermediate-width proof.",
    expected: "0 refusals; `h` Float[0,1000000007] double, `i` int",
    code: `# float recurrence: the 31.4159 sibling of rolling_hash — the same
# modulo shape, but the recurrence runs in floating point.
h = 0
for i in range(2000000):
    h = (h * 31.4159 + i) % 1000000007
print(h)
`,
  },
  {
    name: "bigint-huge-guard",
    desc: "the huge-guard promotion: `while i < 10^55` lets the counter exceed i64, so an i64 C type would wrap — py2cy promotes `i` to the GMP tier instead, materialises the bound once via mpz_set_str into a hidden temp, and rewrites the guard to mpz_cmp. Doubling 2**100 past 10**55 takes ~80 iterations, so this one terminates and prints.",
    expected: "0 refusals; `cdef mpz_t i` + hidden bound temp, mpz_cmp guard",
    code: `# huge-guard promotion: the counter outgrows i64, so it takes the
# GMP tier (not a wrapping long long). Doubling 2**100 past 10**55 takes
# ~80 iterations, so this one terminates and prints.
i = 2 ** 100
while i < 1000000000000000000000000000000000000000000000000000000:
    i = i * 2
print(i % 1000000007)
`,
  },
  {
    name: "while-descending",
    desc: "a descending while guard: `while i > 0` with `i = i - 1` bounds the loop head to i ∈ [0,5] — the mirror image of while-count's ascending guard. Guards, not just range(), are proof sources.",
    expected: "0 refusals; `i` Int[0,5] int",
    code: `i = 5
while i > 0:
    i = i - 1
print(i)
`,
  },
  {
    name: "short-loop-exact",
    desc: "exact unrolling: a counted loop with at most 64 trips is run body-for-body instead of widened to the loop invariant, so range(2) proves the reachable h ∈ [1,1] — `cdef int h`, not the blanket long long a long loop would need.",
    expected: "0 refusals; `h` Int[1,1] int (exact, not widened)",
    code: `h = 0
for i in range(2):
    h = (h * 31 + i) % 1000000007
print(h)
`,
  },
  {
    name: "strings",
    desc: "the Str tier: string concatenation stays a string, so both names earn `cdef str` (unicode in pure-Python mode). The smallest proof in the corpus — and the reason print() of a literal never needs a refusal.",
    expected: "0 refusals; `greeting`/`name` str",
    code: `greeting = "hello"
name = "world"
print(greeting + " " + name)
`,
  },
  {
    name: "builtins",
    desc: "the modelled builtins in one place: a bool proves its exact value (True → Int[1,1]), abs() of a proved int stays proved, float() of an int proves a double, int/int / is true division (proved double — refused on a zero divisor), // is floor division even for negatives (-7 // 2 is -4, not C-truncation -3), int() truncates toward zero, and += is modelled as s = s + i, so the accumulator here is exactly Int[45,45], not a guess.",
    expected: "0 refusals; bool/abs/float()/true-division/floor-division/truncation/aug-assign all typed",
    code: `flag = True
n = -42
m = abs(n)
x = float(m)
q = 7 / 2
f = 7 // 2
g = int(7 / 2)
s = 0
for i in range(10):
    s += i
print(flag, m, x, q, f, g, s)
`,
  },
  {
    name: "width-ladder",
    desc: "the C integer width ladder in one file: int, then unsigned int at 3×10^9 (past i32, inside u32), then unsigned long long at 10^19 (past i64, inside u64). The next rung — past u64 — is the GMP tier (see bignum_mul).",
    expected: "0 refusals; int / unsigned int / unsigned long long",
    code: `tiny = 5
wide = 3000000000
big = 10000000000000000000
print(tiny, wide, big)
`,
  },
  {
    name: "float-single",
    desc: "single precision, but ONLY where it is provably identical. A `cdef float` changes the arithmetic of every expression whose operands are all float/int (C promotes to double only when some operand is double), so py2cy keeps the proof only when every value is a dyadic m·2^-s with |m| ≤ 2^24 — then binary32 rounds nothing. Here 42, 3.5, 0.5, 4.0 are exact → `cdef float`; 0.1 has a 53-bit significand → it stays `cdef double` (REFUSE > GUESS).",
    expected: "4 `cdef float` (x,q,half,r) + 1 `cdef double` (d)",
    code: `# single precision only when provably identical. 42, 3.5, 0.5, 4.0 are
# binary32-exact (m·2^-s with |m| <= 2^24) so float rounds nothing; 0.1 is
# not, so it stays a double.
x = float(42)
q = 7 / 2
half = 0.5
r = q + half
d = 0.1
print(x, q, half, r, d)
`,
  },
  {
    name: "float-list",
    desc: "the float32 memoryview: a list whose elements are all binary32-exact becomes `array('f', …)` + a `float[:]` view — half the memory of a double sequence, with each element already the value CPython would hold. An inexact element (0.1), a mixed int/float list, or any non-iteration use (indexing, len, append) blocks the view and it stays a plain `cdef list`.",
    expected: "0 refusals; `cdef float[:] arr = array('f', …)` + `cdef float v`",
    code: `# a float list that is only iterated, with every element binary32-exact:
# array('f') + a float[:] memoryview (the buffer import is emitted).
arr = [0.5, 1.5, 2.5, 4.0]
for v in arr:
    print(v)
`,
  },
];

export function getExamples() { return EXAMPLES; }
export function getExample(name) { return EXAMPLES.find((e) => e.name === name) || null; }
