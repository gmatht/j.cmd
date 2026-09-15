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
    desc: "a bounded loop plus a reduction. Everything has a proved range, so every local is typed; note the annotated file stays valid, runnable Python.",
    expected: "int/long long locals, no refusals",
    code: `total = 0
for i in range(1000):
    total = total + i * i
print(total)
`,
  },
  {
    name: "int-list",
    desc: "a proved int list — py2cy declares it as a sequence and types the accumulator. A list of unknowns would stay a Python object (never guessed).",
    expected: "list + typed accumulator",
    code: `arr = [3, 1, 4, 1, 5, 9, 2, 6]
total = 0
for v in arr:
    total = total + v
print(total)
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
    desc: "a while loop with an unbounded trip count — the counter is only typed if its range can be proved, so here it stays a Python object (unlike the range() form).",
    expected: "possibly unproved counter (honest)",
    code: `i = 0
while i < 100:
    i = i + 1
print(i)
`,
  },
];

export function getExamples() { return EXAMPLES; }
export function getExample(name) { return EXAMPLES.find((e) => e.name === name) || null; }
