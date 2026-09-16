// ─── py2cy — the automatic typed-Cython annotator (DOM-free) ────
//
// Implements the design in otranspiler-frontends/docs/AUTO_CYTHON.md
// (§5 output surface, §6 soundness hazards, §8 first milestone).
//
// py2cy is a *same-language accelerator*, not a neutral backend: the
// input is Python source and the output is **typed Cython** — the
// annotations a human would otherwise write by hand (the exact ones in
// py-sh-go/profile_example/bench/cython/*_typed.pyx).
//
// Two output surfaces (§5, recommended = mode 2):
//   • mode 2 "pure" — pure-Python-mode `.py`: cython.declare(...) /
//     @cython.locals(...). The file STAYS valid, runnable Python.
//   • mode 1 "pyx"  — traditional `.pyx`: cdef declarations + cimport,
//     matching the hand-written bench goldens byte-for-byte in intent.
//
// The governing rule (§6): **an annotation is a proof, not a guess.**
// Every declaration is emitted only when this module has *proved* the
// type (a conservative abstract interpretation over the Python subset);
// everything else is emitted as plain Python and recorded in the
// REFUSAL MANIFEST, which is the honest contract of a partial
// annotator. Nothing here ever changes program semantics: an unproved
// `int` stays a Python object (correct, no win), never a wrapping C
// `long long` (silent UB).
//
// The module is deliberately dependency-free and DOM-free so it can run
// in a Web Worker, on the main thread, or under Node for the smoke test.
// -----------------------------------------------------------------

// ─── tiny lexer ─────────────────────────────────────────────────
// Python indentation is significant; we keep every physical line, its
// indent (columns), and a token list. Only the subset we can *prove*
// is analysed further — everything else is passed through verbatim.
function lexLines(source) {
  const raw = String(source).replace(/\r\n?/g, "\n").split("\n");
  const lines = raw.map((text, i) => {
    const stripped = text.replace(/\s+$/, "");
    const indentMatch = /^[ \t]*/.exec(text)[0];
    return { n: i + 1, text, indent: indentMatch.replace(/\t/g, "        ").length, blank: stripped.trim() === "" };
  });
  return lines;
}

// Keywords/ops/names — enough for the analysable subset. A token whose
// kind is "op" carries the operator text; "num"/"str"/"name" are atoms.
const OPS3 = ["**=", "//=", ">>=", "<<="];
const OPS2 = ["**", "//", "<<", ">>", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="];
const OPS1 = "+-*/%<>=()[],:.&|^~@;{}";
function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "#") break;                            // comment to EOL
    if (c === '"' || c === "'") {                    // string literal (single/double/triple)
      const q = c;
      let j = i + 3 <= s.length && s.slice(i, i + 3) === q.repeat(3) ? i + 3 : i + 1;
      const triple = j === i + 3;
      while (j < s.length) {
        if (s[j] === "\\") { j += 2; continue; }
        if (triple) { if (s.slice(j, j + 3) === q.repeat(3)) { j += 3; break; } }
        else if (s[j] === q) { j++; break; }
        j++;
      }
      toks.push({ k: "str", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] || ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?j?)/.exec(s.slice(i));
      toks.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      toks.push({ k: "name", v: m[0] });
      i += m[0].length;
      continue;
    }
    const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
    if (OPS3.includes(three)) { toks.push({ k: "op", v: three }); i += 3; continue; }
    if (OPS2.includes(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    toks.push({ k: "op", v: c });                    // unknown byte — keep it, the parser will refuse
    i++;
  }
  return toks;
}

// ─── parser (a Python subset → a small AST) ─────────────────────
// Statements we can prove things about are parsed; anything else makes
// the enclosing block "opaque" (statements kept as raw text, the block
// refused from typing). This mirrors py-sh-go's REFUSE > GUESS stance.
const CONTROL_KW = new Set(["if", "elif", "else", "for", "while", "try", "except", "finally", "with", "def", "class", "return", "pass", "break", "continue", "import", "from", "global", "nonlocal", "del", "assert", "raise", "yield", "lambda", "async", "await"]);

class Refuse {
  constructor(reason, line) { this.reason = reason; this.line = line; }
}

// Parse one logical line's expression tokens → expr node (or Refuse).
function parseExpr(toks) {
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (v) => (peek() && peek().v === v ? (pos++, true) : false);
  function primary() {
    const t = peek();
    if (!t) throw new Refuse("empty expression");
    if (t.k === "num") { pos++; return { t: "num", v: t.v, raw: t.v }; }
    if (t.k === "str") { pos++; return { t: "str", v: t.v }; }
    if (t.k === "name") {
      pos++;
      if (t.v === "True" || t.v === "False") return { t: "bool", v: t.v };
      if (t.v === "None") return { t: "none" };
      if (t.v === "not") return { t: "unary", op: "not", a: primary() };
      if (t.v === "lambda") throw new Refuse("lambda — not analysable");
      if (peek() && peek().v === "(") {              // call
        pos++; // (
        const args = [];
        if (!eat(")")) {
          for (;;) {
            let kw = null;
            if (peek() && peek().k === "name" && toks[pos + 1] && toks[pos + 1].v === "=") {
              kw = peek().v; pos += 2;
            }
            if (eat("*")) args.push({ star: true, kw, e: null });
            else if (peek() && peek().v === ")") { /* trailing comma */ }
            else args.push({ star: false, kw, e: expr() });
            if (eat(",")) { if (eat(")")) break; continue; }
            if (eat(")")) break;
            throw new Refuse("malformed call");
          }
        }
        return { t: "call", fn: t.v, args };
      }
      if (peek() && peek().v === "[") {              // subscript
        pos++;
        const idx = [];
        if (!eat("]")) { for (;;) { if (eat(":")) idx.push({ slice: true }); else idx.push({ slice: false, e: expr() }); if (eat(",")) continue; if (eat("]")) break; throw new Refuse("malformed subscript"); } }
        return { t: "index", base: { t: "name", v: t.v }, baseName: t.v, idx };
      }
      return { t: "name", v: t.v };
    }
    if (t.v === "(") { pos++; const e = expr(); if (!eat(")")) throw new Refuse("unbalanced ("); return e; }
    if (t.v === "[" ) { pos++; const items = []; if (!eat("]")) { for (;;) { items.push(expr()); if (eat(",")) continue; if (eat("]")) break; throw new Refuse("malformed list"); } } return { t: "list", items }; }
    if (t.v === "-" || t.v === "+" || t.v === "~") { pos++; return { t: "unary", op: t.v, a: primary() }; }
    throw new Refuse("unexpected token " + JSON.stringify(t.v));
  }
  function power() {
    let a = primary();
    while (eat("**")) a = { t: "bin", op: "**", a, b: primary() };
    return a;
  }
  function unary() { return eat("-") ? { t: "unary", op: "-", a: unary() } : power(); }
  function mul() { let a = unary(); while (peek() && ["*", "/", "//", "%"].includes(peek().v)) { const op = toks[pos++].v; a = { t: "bin", op, a, b: unary() }; } return a; }
  function add() { let a = mul(); while (peek() && ["+", "-"].includes(peek().v)) { const op = toks[pos++].v; a = { t: "bin", op, a, b: mul() }; } return a; }
  function shift() { let a = add(); while (peek() && ["<<", ">>"].includes(peek().v)) { const op = toks[pos++].v; a = { t: "bin", op, a, b: add() }; } return a; }
  function band() { let a = shift(); while (eat("&")) a = { t: "bin", op: "&", a, b: shift() }; return a; }
  function bxor() { let a = band(); while (eat("^")) a = { t: "bin", op: "^", a, b: band() }; return a; }
  function bor() { let a = bxor(); while (eat("|")) a = { t: "bin", op: "|", a, b: bxor() }; return a; }
  function cmp() {
    let a = bor();
    while (peek() && ["<", ">", "==", "!=", "<=", ">="].includes(peek().v)) { const op = toks[pos++].v; a = { t: "cmp", op, a, b: bor() }; }
    return a;
  }
  function expr() { return cmp(); }
  const e = expr();
  if (pos !== toks.length) throw new Refuse("trailing tokens: " + toks.slice(pos).map((t) => t.v).join(" "));
  return e;
}

// ─── abstract interpreter: prove Int / Str / Any + integer ranges ─
// The lattice is deliberately tiny (AUTO_CYTHON §6): Int(v) with an
// optional [lo,hi] range, Str, SeqInt (a list of ints), and Any (the
// unknown — never typed). Range arithmetic is interval arithmetic; any
// operation that could overflow 64 bits widens to BigInt, which is
// where the GMP tier (§1b) kicks in.
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;   // widest C machine word (`unsigned long long`)
// Counted loops with a known trip count up to this are UNROLLED exactly
// (see analyzeModule), so a short loop proves the reachable range instead
// of the wider loop invariant. Longer loops keep the widening fixpoint
// (whose conservative `%` rule is what makes that fixpoint terminate).
const UNROLL_CAP = 64n;

function isIntType(t) { return t.kind === "int"; }
function typeName(t) {
  if (!t) return "Any";
  if (t.kind === "int") return "Int" + (t.lo != null || t.hi != null ? "[" + (t.lo ?? "?") + "," + (t.hi ?? "?") + "]" : "");
  if (t.kind === "str") return "Str";
  if (t.kind === "float") return t.dy ? "Float32" : "Float";
  if (t.kind === "floatlist") return "Float32List";
  if (t.kind === "list") return "SeqInt";
  if (t.kind === "big") return "BigInt";
  return "Any";
}

function intTy(lo, hi, need) { return { kind: "int", lo: lo ?? null, hi: hi ?? null, need: need == null ? null : need }; }
// BIG is the i64-exceeding tier: the value is an exact Python int that C
// cannot hold, so it takes the GMP FFI (§1b / bignum_typed.pyx). A bigint
// variable stays BIG for its whole life (join keeps it BIG).
const BIG = { kind: "big" };
function isBigType(t) { return t && t.kind === "big"; }
const STR = { kind: "str" };
const ANY = { kind: "any" };
const LIST = { kind: "list" };

// choose the narrowest Cython C type that is SOUND for a proved range.
// `need` is the widest intermediate magnitude the variable's definitions
// require (see Annotator.typeOf): a value in [0,1e9] that is produced by
// `*31` must be `long long` even though its value fits in `int`.
function cTypeForRange(lo, hi, need) {
  const LIM_I32 = 2147483648n;                   // |x| < 2^31
  const LIM_U32 = 4294967296n;                   // 0 <= x < 2^32
  const LIM_I64 = 2n ** 63n;                     // |x| < 2^63
  const LIM_U64 = 2n ** 64n;                     // 0 <= x < 2^64
  const n = need == null ? 0n : need;
  if (lo == null || hi == null) return n >= LIM_I64 ? "long long" : "long long";   // unbounded value → widest *signed* C int (sign unknown)
  const fitsI32 = lo >= -LIM_I32 && hi < LIM_I32 && n < LIM_I32;
  const fitsU32 = lo >= 0n && hi < LIM_U32 && n < LIM_U32;
  if (fitsI32) return "int";
  if (fitsU32) return "unsigned int";
  // 64-bit: `long long` unless a non-negative range exceeds i64 — then the
  // machine word is `unsigned long long`, still exact and still C-fast.
  if (lo >= 0n && hi < LIM_U64 && n < LIM_U64) {
    return (hi < LIM_I64 && n < LIM_I64) ? "long long" : "unsigned long long";
  }
  return "long long";   // signed i64 (promote guarantees the fit)
}

function numVal(raw) {
  const s = String(raw).replace(/_/g, "");
  try {
    if (/^0[xX]/.test(s)) return BigInt(s);
    if (/^0[bB]/.test(s)) return BigInt(s);
    if (/^0[oO]/.test(s)) return BigInt(s);
    if (/\./.test(s) || /[eE]/.test(s) || /j$/.test(s)) return null;   // float — not Int
    return BigInt(s);
  } catch { return null; }
}

// ─── Float tier (proved finite doubles → `cdef double`) ─────────
// CPython floats ARE C doubles (IEEE-754 binary64), and Cython's `cdef
// double` arithmetic with cdivision=False matches CPython for + - * / %
// on finite operands — verified empirically against Cython 3.x (incl.
// signed zeros, negative moduli, and ZeroDivisionError on both sides).
// So "the value is a finite float, and every operation on it is in
// {+,-,*,/,%} with a provably nonzero divisor" IS a complete proof that
// `cdef double` is exact. Anything else (//, **, math.*, str↔float
// parsing, huge-int conversion) is Any — REFUSE > GUESS.
function floatVal(raw) {
  const s = String(raw).replace(/_/g, "");
  if (/j$/.test(s)) return null;                        // complex
  const f = Number(s);
  return Number.isFinite(f) ? f : null;                 // inf literals (1e1000) are not finite
}

// outward-rounded double stepping for sound float intervals
const _f64bits = new DataView(new ArrayBuffer(8));
function nextUp(x) {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === -Infinity) return -Number.MAX_VALUE;
  if (x === 0) return Number.MIN_VALUE;                 // ±0 → smallest subnormal
  _f64bits.setFloat64(0, x, true);
  let lo = _f64bits.getUint32(0, true), hi = _f64bits.getUint32(4, true);
  if (x > 0) { lo++; if (lo === 0x100000000) { lo = 0; hi++; } }
  else { if (lo === 0) { lo = 0xFFFFFFFF; hi--; } else lo--; }
  _f64bits.setUint32(0, lo, true);
  _f64bits.setUint32(4, hi, true);
  return _f64bits.getFloat64(0, true);
}
function nextDown(x) { return -nextUp(-x); }

// a type as a finite-double interval, or null (unprovable as float).
// The int branch also attaches the EXACT dyadic proof when the whole range
// is binary32-representable (see the tier comment below), so `float(n)` of
// a small int earns a `cdef float`.
function toFloatTy(t) {
  if (!t) return null;
  if (t.kind === "float") {
    return (Number.isFinite(t.lo) && Number.isFinite(t.hi)) ? t : null;
  }
  if (t.kind === "int") {
    // only bounded ints convert: an unbounded int has no finite hull, and
    // anything beyond i64 is already BigInt (rejected below)
    if (t.lo == null || t.hi == null) return null;
    const lo = Number(t.lo), hi = Number(t.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    const out = { kind: "float", lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
    const dy = intDyadic(t.lo, t.hi);
    if (dy) out.dy = dy;
    return out;
  }
  return null;
}

// ─── binary32 exactness: the `cdef float` tier ──────────────────
// A real is exactly representable in binary32 iff it is m·2^-s with
// |m| <= 2^24 and -103 <= s <= 126 (24-bit significand; no subnormal
// underflow, no overflow). When EVERY value a float flows through satisfies
// that, binary32 rounding is the identity — so a `cdef float` computes
// bit-for-bit what CPython's binary64 does (binary32 ⊂ binary64, so the
// double rounding is the identity too). This lattice carries the EXACT
// dyadic alongside the (outward-rounded) double interval: no dyadic ⇒ the
// value stays `cdef double`.
const F32_MANT = 1n << 24n;
const F32_MIN_S = -103, F32_MAX_S = 126;

function dyFits(dy) {
  if (!dy || dy.s < F32_MIN_S || dy.s > F32_MAX_S) return false;
  const a = dy.mLo < 0n ? -dy.mLo : dy.mLo, b = dy.mHi < 0n ? -dy.mHi : dy.mHi;
  return (a > b ? a : b) <= F32_MANT;
}

// exact dyadic form of a double singleton, or null (needs > 24 bits).
// Normalised to an ODD mantissa, so a 53-bit significand like 0.1 or 31.4159
// is rejected while 0.5 / 3.5 / 42 / 2^30 are accepted.
function doubleDyadic(x) {
  if (!Number.isFinite(x)) return null;
  if (x === 0) return { mLo: 0n, mHi: 0n, s: 0 };
  const neg = x < 0, ax = Math.abs(x);
  _f64bits.setFloat64(0, ax, true);
  const hiBits = _f64bits.getUint32(4, true), loBits = _f64bits.getUint32(0, true);
  const exp = (hiBits >>> 20) & 0x7ff;
  let m = (BigInt(hiBits & 0xfffff) << 32n) | BigInt(loBits), e;
  if (exp === 0) e = -1074; else { m |= 1n << 52n; e = exp - 1075; }
  while ((m & 1n) === 0n) { m >>= 1n; e += 1; }        // m odd, value = m·2^e
  const dy = neg ? { mLo: -m, mHi: -m, s: -e } : { mLo: m, mHi: m, s: -e };
  return dyFits(dy) ? dy : null;
}

// exact dyadic form of a bounded integer interval, or null. Within ±2^24
// every integer is representable; beyond it only a proved singleton can be
// (2^30 yes, 2^24+1 no) — representability is not interval-closed.
function intDyadic(lo, hi) {
  if (lo == null || hi == null) return null;
  if (lo >= -F32_MANT && hi <= F32_MANT) return { mLo: lo, mHi: hi, s: 0 };
  if (lo !== hi) return null;
  if (lo === 0n) return { mLo: 0n, mHi: 0n, s: 0 };
  const neg = lo < 0;
  let m = neg ? -lo : lo, t = 0;
  while ((m & 1n) === 0n) { m >>= 1n; t += 1; }
  const dy = neg ? { mLo: -m, mHi: -m, s: -t } : { mLo: m, mHi: m, s: -t };
  return dyFits(dy) ? dy : null;
}

// re-express a dyadic at a coarser scale (only ever s' >= s)
function dyScale(dy, s) {
  const k = BigInt(s - dy.s);
  return { mLo: dy.mLo << k, mHi: dy.mHi << k };
}

// float arithmetic with CPython-identical semantics: every accepted op is
// computed with outward rounding, and any unbounded (infinite) outcome is
// refused rather than declared. `dy` is carried only when the EXACT result
// is binary32-representable, which is what licenses a `cdef float`.
function floatBinType(op, a, b) {
  const A = toFloatTy(a), B = toFloatTy(b);
  if (!A || !B) return ANY;
  const F = (lo, hi, dy) => { const t = { kind: "float", lo, hi }; if (dyFits(dy)) t.dy = dy; return t; };
  const ad = A.dy, bd = B.dy;
  switch (op) {
    case "+": case "-": {
      const lo = op === "+" ? A.lo + B.lo : A.lo - B.hi;
      const hi = op === "+" ? A.hi + B.hi : A.hi - B.lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ANY;
      let dy = null;
      if (ad && bd) {
        const s = Math.max(ad.s, bd.s);
        const x = dyScale(ad, s), y = dyScale(bd, s);
        dy = op === "+" ? { mLo: x.mLo + y.mLo, mHi: x.mHi + y.mHi, s }
                        : { mLo: x.mLo - y.mHi, mHi: x.mHi - y.mLo, s };
      }
      return F(nextDown(lo), nextUp(hi), dy);
    }
    case "*": {
      const ps = [A.lo * B.lo, A.lo * B.hi, A.hi * B.lo, A.hi * B.hi];
      if (ps.some((p) => !Number.isFinite(p))) return ANY;
      let dy = null;
      if (ad && bd) {
        const q = [ad.mLo * bd.mLo, ad.mLo * bd.mHi, ad.mHi * bd.mLo, ad.mHi * bd.mHi];
        dy = { mLo: minBig(q), mHi: maxBig(q), s: ad.s + bd.s };
      }
      return F(nextDown(Math.min(...ps)), nextUp(Math.max(...ps)), dy);
    }
    case "/": {
      // CPython raises ZeroDivisionError on a zero divisor (Cython does too
      // under cdivision=False), so the divisor must provably exclude 0.
      if (!(B.lo > 0 || B.hi < 0)) return ANY;
      // exact division is only proved for a power-of-two divisor (a pure
      // exponent shift); anything else is not binary32-exact in general.
      let dyDiv = null;
      if (ad && bd && bd.mLo === bd.mHi && bd.mLo !== 0n) {
        const mb = bd.mLo, neg = mb < 0n, am = neg ? -mb : mb;
        if ((am & (am - 1n)) === 0n) {
          let j = 0n, t = am;
          while (t > 1n) { t >>= 1n; j += 1n; }
          const s = ad.s + Number(j) - bd.s;
          dyDiv = neg ? { mLo: -ad.mHi, mHi: -ad.mLo, s } : { mLo: ad.mLo, mHi: ad.mHi, s };
        }
      }
      // singleton / singleton: the correctly-rounded quotient ±1 ulp
      // (IEEE division is exact-rounded, so this brackets the truth).
      if (A.lo === A.hi && B.lo === B.hi) {
        const q = A.lo / B.lo;
        if (!Number.isFinite(q)) return ANY;
        return F(nextDown(q), nextUp(q), dyDiv);
      }
      // otherwise bound the magnitude by |a|max/|b|min, else overflow→refuse.
      const minAbs = B.lo > 0 ? B.lo : -B.hi;
      const maxA = Math.max(Math.abs(A.lo), Math.abs(A.hi));
      const q = maxA / minAbs;
      if (!Number.isFinite(q)) return ANY;
      const m = nextUp(q);
      // the sign follows the operands (0 is always a sound bound there)
      if (A.lo >= 0 && B.lo > 0) return F(0, m, dyDiv);
      if (A.hi <= 0 && B.hi < 0) return F(0, m, dyDiv);
      if (A.lo >= 0 && B.hi < 0) return F(-m, 0, dyDiv);
      if (A.hi <= 0 && B.lo > 0) return F(-m, 0, dyDiv);
      return F(-m, m, dyDiv);
    }
    case "%": {
      // Python floor-mod takes the divisor's sign; |result| < |divisor|.
      // A zero-crossing divisor could raise → refuse. No dyadic proof (the
      // residue is exact only for special divisors), so `%` keeps `double`.
      if (!(B.lo > 0 || B.hi < 0)) return ANY;
      if (B.lo > 0) return F(0, B.hi, null);
      return F(B.lo, 0, null);
    }
    default: return ANY;          // //, **, shifts, bitwise — not modelled
  }
}

// ─── the analysis pass ──────────────────────────────────────────
// One pass over the parsed module that:
//   • records a proven type per (scoped) variable,
//   • records the inferred loop bounds for counted `for … range(…)`,
//   • records bigint variables (values beyond i64),
//   • collects refusals (constructs it will not annotate).
class Annotator {
  constructor(opts) {
    this.opts = opts || {};
    this.vars = new Map();          // name → type (module scope)
    this.funcs = new Map();         // name → { params, returns, rangeFor }
    this.refusals = [];             // { line, construct, reason, site }
    this._refuseKeys = new Set();   // dedupe (see refuse())
    this.bigints = new Set();       // names needing the GMP FFI tier
    this.lists = new Set();         // names proven to be int lists
    this.notes = new Map();         // scoped name → human-readable evidence
    this.unstable = new Set();      // scoped names whose loop never converged
    this.listViews = new Map();     // name → { typecode, view, line, text } for memoryview lists
    this.exact = false;             // true only while unrolling a short loop
  }

  refuse(line, construct, reason, site) {
    // dedupe: the same site can be reached from the flow walk AND the
    // declaration builder (e.g. an unproved loop counter) — the manifest
    // should read as one entry per fact.
    const key = [line, construct, reason, site].join("\u0000");
    if (this._refuseKeys.has(key)) return;
    this._refuseKeys.add(key);
    this.refusals.push({ line, construct, reason, site: site || construct });
  }

  // bind/merge a variable's type (join = widen to Any on mismatch)
  bind(name, ty) {
    const prev = this.vars.get(name);
    this.vars.set(name, prev ? joinTy(prev, ty) : ty);
  }

  // ── expression typing ──
  // Every Int type carries TWO facts (AUTO_CYTHON §6, the "unbounded int
  // wraps silently" hazard):
  //   • lo/hi — the range of the *value* (what a C type must hold), and
  //   • need  — the magnitude of the widest *intermediate* in the
  //             expression that produced it (what the arithmetic runs in).
  // `h = (h * 31 + i) % M` is the canonical case: the value of `h` is in
  // [0, M) ⊂ i32, but the intermediate `h * 31 + i` needs 64 bits — so
  // `h` must be `long long`, not `int`, or the C multiplication wraps.
  typeOf(e, env) {
    switch (e.t) {
      case "num": {
        // an integer literal beyond u64 (or below i64) is a bigint (GMP
        // tier); a literal in (i64, u64] is an unsigned-long-long int
        const v = numVal(e.raw ?? e.v);
        if (v != null) {
          if (v > U64_MAX || v < I64_MIN) return BIG;
          return intTy(v, v, absBig(v));
        }
        // a finite decimal/scientific literal is a finite double; anything
        // else numeric-but-unrepresentable (inf literal, complex) is Any
        const f = floatVal(e.raw ?? e.v);
        if (f == null) return ANY;
        const ft = { kind: "float", lo: f, hi: f };
        const dy = doubleDyadic(f);
        if (dy) ft.dy = dy;
        return ft;
      }
      case "str": return STR;
      case "bool": return e.v === "True" ? intTy(1n, 1n, 1n) : intTy(0n, 0n, 0n);
      case "none": return ANY;
      case "name": return env.get(e.v) || ANY;
      case "list": {
        const ts = e.items.map((it) => this.typeOf(it, env));
        if (ts.length === 0) return { kind: "intlist", lo: null, hi: null, need: 0n };
        // all-int: the existing int-list tier
        if (ts.every(isIntType)) {
          let lo = null, hi = null, need = 0n;
          for (const t of ts) { lo = minBound(lo, t.lo); hi = maxBound(hi, t.hi); need = maxBig([need, t.need ?? 0n]); }
          return { kind: "intlist", lo, hi, need };
        }
        // all-float AND every element binary32-exact: a `float` list. (A
        // mixed list is refused: array('f') would make an int element print
        // 1.0 where CPython prints 1.)
        if (ts.every((t) => t && t.kind === "float" && t.dy && Number.isFinite(t.lo) && Number.isFinite(t.hi))) {
          const lo = Math.min(...ts.map((t) => t.lo)), hi = Math.max(...ts.map((t) => t.hi));
          const s = Math.max(...ts.map((t) => t.dy.s));
          let mLo = null, mHi = null;
          for (const t of ts) { const d = dyScale(t.dy, s); mLo = mLo === null ? d.mLo : minBig([mLo, d.mLo]); mHi = mHi === null ? d.mHi : maxBig([mHi, d.mHi]); }
          const dy = { mLo, mHi, s };
          if (dyFits(dy)) return { kind: "floatlist", lo, hi, dy };
        }
        return LIST;
      }
      case "unary": {
        const a = this.typeOf(e.a, env);
        if (e.op === "not") return intTy(0n, 1n, 1n);
        if (e.op === "~") return isIntType(a) ? intTy(null, null, a.need ?? 0n) : ANY;
        if (e.op === "-") {
          if (isBigType(a)) return BIG;
          if (a.kind === "float") { const t = { kind: "float", lo: -a.hi, hi: -a.lo }; if (a.dy) t.dy = { mLo: -a.dy.mHi, mHi: -a.dy.mLo, s: a.dy.s }; return t; }
          if (!isIntType(a)) return ANY;
          const lo = a.hi == null ? null : -a.hi, hi = a.lo == null ? null : -a.lo;
          // negation can push a u64 literal below i64 (e.g. -(2^63+1)) —
          // route bounded results through promote so unrepresentable signs
          // become BIG instead of a wrapping C type
          if (lo == null || hi == null) return intTy(lo, hi, a.need ?? 0n);
          return promote(lo, hi, a.need ?? 0n);
        }
        return a;
      }
      case "bin": return this.binType(e, env);
      case "cmp": return intTy(0n, 1n, maxBig([this.typeOf(e.a, env).need ?? 0n, this.typeOf(e.b, env).need ?? 0n]));
      case "index": {
        const b = env.get(e.baseName);
        if (b && (b.kind === "intlist" || b.kind === "list")) return intTy(b.lo, b.hi, b.need);
        return ANY;
      }
      case "call": return this.callType(e, env);
      default: return ANY;
    }
  }

  binType(e, env) {
    const a = this.typeOf(e.a, env), b = this.typeOf(e.b, env);
    if (e.op === "+" && (a.kind === "str" || b.kind === "str")) return STR;   // "a" + "b"
    // a float on either side takes the Float tier (see the tier comment at
    // floatVal): only + - * / % with finite operands are proved, the rest
    // is Any — and crucially never an int/bigint claim. `/` is always true
    // division in Python (even int/int), so it takes the float path too.
    if (e.op === "/" || a.kind === "float" || b.kind === "float") return floatBinType(e.op, a, b);
    // an operation touching a bigint stays a bigint (exact, and the reason
    // the GMP FFI tier exists: Cython has no native big-int).
    if (isBigType(a) || isBigType(b)) {
      if (e.op === "**" || e.op === "*" || e.op === "+" || e.op === "-" || e.op === "//" || e.op === "%") return BIG;
      return isBigType(a) ? BIG : BIG;
    }
    if (!isIntType(a) || !isIntType(b)) return ANY;
    const iv = (x) => (x.lo == null || x.hi == null ? null : [x.lo, x.hi]);
    const A = iv(a), B = iv(b);
    const needAB = maxBig([a.need ?? 0n, b.need ?? 0n]);
    // a u64-exceeding magnitude is the GMP tier's job, not a wrapping C
    // int (AUTO_CYTHON §6, the first hazard in the table).
    const overU64 = (n) => n != null && n > U64_MAX;
    const unbounded = overU64(needAB) ? BIG : intTy(null, null, needAB);
    switch (e.op) {
      case "+": return A && B ? promote(A[0] + B[0], A[1] + B[1], maxBig([magnitude([A[0] + B[0], A[1] + B[1]]), needAB])) : unbounded;
      case "-": return A && B ? promote(A[0] - B[1], A[1] - B[0], maxBig([magnitude([A[0] - B[1], A[1] - B[0]]), needAB])) : unbounded;
      case "**": {
        // an int power: exact if we can compute it, else the bigint tier
        if (A && B && A[0] === A[1] && B[0] === B[1] && B[0] >= 0n && B[0] < 4096n) {
          const v = A[0] ** B[0];
          return promote(v, v, absBig(v));
        }
        return BIG;
      }
      case "*": {
        if (!A || !B) return unbounded;
        const c = [A[0] * B[0], A[0] * B[1], A[1] * B[0], A[1] * B[1]];
        // the product's own magnitude is an INTERMEDIATE for anything that
        // consumes it — this is where `h * 31` forces the 64-bit width.
        return promote(minBig(c), maxBig(c), maxBig([magnitude(c), needAB]));
      }
      case "//": {
        // Python floor-division (NOT C truncation): the divisor must be a
        // proved-positive range, and the extremes sit at the corners — min
        // over (A.lo × B), max over (A.hi × B) — with true flooring, since
        // BigInt `/` truncates toward zero (wrong for negative dividends:
        // -7 // 2 is -4, not -3).
        if (!A || !B || B[0] === 0n || B[1] === 0n) return unbounded;
        if (B[0] < 0n) return unbounded;                 // sign-crossing divisor — refuse a proof
        const fl = (a, b) => (a >= 0n ? a / b : -(((-a) + b - 1n) / b));
        const lo = minBig([fl(A[0], B[0]), fl(A[0], B[1])]);
        const hi = maxBig([fl(A[1], B[0]), fl(A[1], B[1])]);
        return promote(lo, hi, maxBig([needAB, magnitude([A[0], A[1]])]));
      }
      case "%": {
        // Python floor-mod: the result is in [0, m) for a positive modulus,
        // and the modulus bounds it — this is the rolling_hash shape.
        if (!B || B[0] <= 0n || B[1] <= 0n || B[0] !== B[1]) return unbounded;
        const m = B[0];
        // a % m ∈ [0, m-1] for any a (Python semantics), which is why the
        // annotated form keeps Python's % and does NOT use cdivision. The
        // NUMERIC result is narrow, but the dividend `a` was still computed
        // at its own width — carry that as `need` so the target is wide
        // enough to evaluate `a` without wrapping.
        const modNeed = maxBig([needAB, m, a.need ?? 0n]);
        // identity case 0 <= a < m ⇒ a % m === a: keep the dividend's
        // (narrower) range. Only valid while UNROLLING a short loop, where
        // the body has been run for every iteration; the widening fixpoint
        // must keep the blanket [0, m-1], or it could stop before covering
        // every reachable value (the modulus is what bounds the loop).
        if (this.exact && A && A[0] >= 0n && A[1] < m) return promote(A[0], A[1], maxBig([a.need ?? 0n, magnitude([A[0], A[1]])]));
        return promote(0n, m - 1n, modNeed);
      }
      default: return unbounded;                          // >>, &, |, ^ — value-unknown but Int
    }
  }

  callType(e, env) {
    switch (e.fn) {
      case "range": return { kind: "range", args: e.args.map((a) => (a.e ? this.typeOf(a.e, env) : ANY)) };
      case "len": {
        const b = e.args[0] && e.args[0].e;
        const t = b ? this.typeOf(b, env) : ANY;
        if (t.kind === "list" || t.kind === "intlist" || t.kind === "range") return intTy(0n, null, 0n);
        if (t.kind === "str") return intTy(0n, null, 0n);
        return intTy(0n, null, 0n);
      }
      case "int": {
        if (!e.args[0]) return intTy(0n, null, 0n);
        const t = this.typeOf(e.args[0].e, env);
        // int() truncates toward zero (exact for finite floats) — provable
        // only when the truncated range fits i64; inf, huge, and unbounded
        // floats stay Python objects (int() of those is still correct
        // Python, just not a C int).
        if (t && t.kind === "float") {
          if (t.lo == null || t.hi == null) return ANY;
          const lo = Math.trunc(t.lo), hi = Math.trunc(t.hi);
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ANY;
          if (lo < -9223372036854775808 || hi > 9223372036854775807) return ANY;
          const loB = BigInt(lo), hiB = BigInt(hi);
          return promote(loB, hiB, maxBig([absBig(loB), absBig(hiB)]));
        }
        return t;
      }
      case "sum": case "min": case "max": {
        // a reduction over a proved int list/range yields an int; the
        // range is not provable without bounds, so it stays unbounded.
        return intTy(null, null, maxBig(e.args.map((a) => (a.e ? this.typeOf(a.e, env).need ?? 0n : 0n))));
      }
      case "abs": {
        const t = e.args[0] ? this.typeOf(e.args[0].e, env) : ANY;
        if (t && t.kind === "float") {
          // abs of a finite float is finite; exact when 0 is outside [lo,hi]
          const m = Math.max(Math.abs(t.lo), Math.abs(t.hi));
          const out = { kind: "float", lo: (t.lo <= 0 && 0 <= t.hi) ? 0 : Math.min(Math.abs(t.lo), Math.abs(t.hi)), hi: m };
          if (t.dy) { const a0 = t.dy.mLo < 0n ? -t.dy.mLo : t.dy.mLo, b0 = t.dy.mHi < 0n ? -t.dy.mHi : t.dy.mHi; const dy = { mLo: 0n, mHi: a0 > b0 ? a0 : b0, s: t.dy.s }; if (dyFits(dy)) out.dy = dy; }
          return out;
        }
        return isIntType(t) ? intTy(t.lo == null || t.hi == null ? null : minBig([absBig(t.lo), absBig(t.hi)]), t.lo == null || t.hi == null ? null : maxBig([absBig(t.lo), absBig(t.hi)])) : ANY;
      }
      case "print": return ANY;
      case "str": case "repr": return STR;
      case "float": {
        // float(x): int→double rounds identically on both sides; a huge int
        // would raise OverflowError in Python, so only finite conversions
        // are proved (toFloatTy rejects the rest).
        const t = e.args[0] ? this.typeOf(e.args[0].e, env) : ANY;
        return toFloatTy(t) || ANY;
      }
      default: return ANY;
    }
  }
}

function bounded(lo, hi, need) { return intTy(lo, hi, need); }
// a proved Int result, promoted to the bigint tier if it exceeds i64
function promote(lo, hi, need) {
  // u64 (or narrower) stays a C machine word — a single register, no heap,
  // no FFI. Only beyond-u64 (or below-i64, which no unsigned type can hold)
  // needs GMP. A signed range exceeding i64 has no C type at all (long long
  // too small, u64 cannot hold negatives), so it is BIG too.
  if (lo >= 0n && hi <= U64_MAX && (need == null || need <= U64_MAX)) return intTy(lo, hi, need);
  if (lo < I64_MIN || hi > I64_MAX) return BIG;
  if (need != null && need > I64_MAX) return BIG;
  return intTy(lo, hi, need);
}
function minBound(a, b) { if (a == null) return b; if (b == null) return a; return a < b ? a : b; }
function maxBound(a, b) { if (a == null) return b; if (b == null) return a; return a > b ? a : b; }
function minBig(a) { return a.reduce((x, y) => (y < x ? y : x)); }
function maxBig(a) { return a.reduce((x, y) => (y > x ? y : x)); }
function absBig(x) { return x < 0n ? -x : x; }
// join two types: equal ints merge their ranges, mismatches widen to Any
// (null on an int bound means UNBOUNDED — the join of top with anything is
// top, so a null bound must absorb, not be dropped).
function joinTy(a, b) {
  if (!a) return b;
  if (!b) return a;
  // a float meeting a bigint is unprovable (no common C representation)
  if (isBigType(a) || isBigType(b)) return (a.kind === "float" || b.kind === "float") ? ANY : BIG;
  // float meets float/int: a C double holds every finite double, and every
  // bounded int converts exactly-or-identically-rounded on both sides, so
  // the join is the float hull; an unbounded int has no finite hull → Any.
  if (a.kind === "float" || b.kind === "float") {
    const f = a.kind === "float" ? a : b, o = a.kind === "float" ? b : a;
    if (o.kind !== "float" && o.kind !== "int") return ANY;
    let lo = f.lo, hi = f.hi;
    if (o.kind === "float") {
      lo = Math.min(lo, o.lo); hi = Math.max(hi, o.hi);
    } else {
      if (o.lo == null || o.hi == null) return ANY;
      lo = Math.min(lo, Number(o.lo)); hi = Math.max(hi, Number(o.hi));
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ANY;
    const out = { kind: "float", lo, hi };
    // the dyadic proof survives the join only when BOTH sides have one
    // (exact on one path and not on another is not exact).
    const fd = f.dy, od = o.kind === "float" ? o.dy : intDyadic(o.lo, o.hi);
    if (fd && od) {
      const s = Math.max(fd.s, od.s);
      const x = dyScale(fd, s), y = dyScale(od, s);
      const dy = { mLo: minBig([x.mLo, y.mLo]), mHi: maxBig([x.mHi, y.mHi]), s };
      if (dyFits(dy)) out.dy = dy;
    }
    return out;
  }
  if (a.kind === b.kind) {
    if (a.kind === "int") {
      const lo = (a.lo == null || b.lo == null) ? null : minBig([a.lo, b.lo]);
      const hi = (a.hi == null || b.hi == null) ? null : maxBig([a.hi, b.hi]);
      return intTy(lo, hi, maxBig([a.need ?? 0n, b.need ?? 0n]));
    }
    if (a.kind === "intlist") {
      const lo = (a.lo == null || b.lo == null) ? null : minBig([a.lo, b.lo]);
      const hi = (a.hi == null || b.hi == null) ? null : maxBig([a.hi, b.hi]);
      return { kind: "intlist", lo, hi, need: maxBig([a.need ?? 0n, b.need ?? 0n]) };
    }
    if (a.kind === "floatlist") {
      const lo = Math.min(a.lo, b.lo), hi = Math.max(a.hi, b.hi);
      const out = { kind: "floatlist", lo, hi };
      if (a.dy && b.dy) {
        const s = Math.max(a.dy.s, b.dy.s);
        const x = dyScale(a.dy, s), y = dyScale(b.dy, s);
        const dy = { mLo: minBig([x.mLo, y.mLo]), mHi: maxBig([x.mHi, y.mHi]), s };
        if (dyFits(dy)) out.dy = dy;
      }
      return out;
    }
    return a;
  }
  return ANY;
}

// magnitude of a list of bounds (the widest |value|)
function magnitude(xs) { return maxBig(xs.map(absBig)); }

// ─── statement parser ───────────────────────────────────────────
// Parses the indentation tree into blocks of statements. Only the
// constructs we can reason about are parsed into structured nodes;
// anything else becomes an `opaque` statement (kept verbatim, the
// enclosing block refused from typing at that site).
function splitTopLevel(toks) {
  // split a token run on commas at depth 0 (for `for a, b` targets)
  const out = [];
  let depth = 0, cur = [];
  for (const t of toks) {
    if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
    else if (t.v === ")" || t.v === "]" || t.v === "}") depth--;
    if (t.v === "," && depth === 0) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

function eqIndex(toks) {
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const v = toks[i].v;
    if (v === "(" || v === "[" || v === "{") depth++;
    else if (v === ")" || v === "]" || v === "}") depth--;
    else if (depth === 0 && ["=", "+=", "-=", "*=", "//=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>="].includes(v)) return i;
  }
  return -1;
}

export function parseBlock(lines, start, end, baseIndent) {
  // returns { stmts: [...], i: nextIndex }. `baseIndent` (optional) stops
  // the block at the first line indented at or below it — that is what
  // keeps a trailing top-level statement from being swallowed into the
  // preceding `while`/`for` body.
  const stmts = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.blank) { i++; continue; }
    if (baseIndent != null && line.indent <= baseIndent) break;
    const toks = tokenize(line.text);
    if (!toks.length) { i++; continue; }
    const head = toks[0].k === "name" ? toks[0].v : null;

    // find the nested block (a deeper-indented run after a ':' header)
    const findBlock = () => {
      let j = i + 1;
      while (j < end && (lines[j].blank || lines[j].indent > line.indent)) {
        if (!lines[j].blank) break;
        j++;
      }
      if (j >= end || lines[j].indent <= line.indent) return { body: null, next: i + 1 };
      const b = parseBlock(lines, j, end, line.indent);
      return { body: b.stmts, next: b.i };
    };

    try {
      if (head === "def") {
        const m = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line.text);
        if (!m) throw new Refuse("unsupported def form");
        const params = parseParams(line.text);
        if (params == null) throw new Refuse("unsupported parameter list");
        const { body, next } = findBlock();
        if (!body) throw new Refuse("def with no body");
        stmts.push({ k: "def", name: m[1], params, body, line: line.n, raw: line.text });
        i = next;
        continue;
      }
      if (head === "for") {
        const idx = line.text.indexOf(" in ");
        if (idx < 0) throw new Refuse("unsupported for form");
        const target = line.text.slice(line.text.indexOf("for") + 3, idx).trim();
        const iterToks = tokenize(line.text.slice(idx + 4, line.text.lastIndexOf(":")));
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) throw new Refuse("tuple loop target");
        const iter = parseExpr(iterToks);
        const { body, next } = findBlock();
        if (!body) throw new Refuse("for with no body");
        stmts.push({ k: "for", target, iter, body, line: line.n, raw: line.text });
        i = next;
        continue;
      }
      if (head === "while") {
        const wCol = line.text.indexOf("while");
        const cond = parseExpr(tokenize(stripColon(line.text.slice(wCol + 5))));
        const { body, next } = findBlock();
        if (!body) throw new Refuse("while with no body");
        stmts.push({ k: "while", cond, body, line: line.n, raw: line.text });
        i = next;
        continue;
      }
      if (head === "if") {
        const branches = [];
        // slice from the COLUMN of the `if` token, not from the line start
        // — an indented header would otherwise lose its first characters.
        const ifCol = line.text.indexOf("if");
        let cond = parseExpr(tokenize(stripColon(line.text.slice(ifCol + 2))));
        let { body, next } = findBlock();
        if (!body) throw new Refuse("if with no body");
        branches.push({ cond, body });
        i = next;
        let elseBody = null;
        // consume elif/else at the SAME indent
        while (i < end) {
          while (i < end && lines[i].blank) i++;
          if (i >= end || lines[i].indent !== line.indent) break;
          const t = lines[i].text.trim();
          const elCol = lines[i].text.indexOf("elif");
          if (t.startsWith("elif") && t.endsWith(":") && elCol >= 0) {
            const c = parseExpr(tokenize(stripColon(lines[i].text.slice(elCol + 4))));
            const r = findBlock();
            if (!r.body) throw new Refuse("elif with no body");
            branches.push({ cond: c, body: r.body });
            i = r.next;
            continue;
          }
          if (t === "else:") {
            const r = findBlock();
            if (!r.body) throw new Refuse("else with no body");
            elseBody = r.body;
            i = r.next;
            continue;
          }
          break;
        }
        stmts.push({ k: "if", branches, elseBody, line: line.n, raw: line.text });
        continue;
      }
      if (head === "return") {
        // slice from the token, NOT the raw line: an indented `return x`
        // would otherwise lose the first characters (the indent width).
        const restToks = toks.slice(1);
        stmts.push({ k: "return", expr: restToks.length ? safeExpr(restToks) : null, line: line.n, raw: line.text });
        i++;
        continue;
      }
      if (["pass", "break", "continue"].includes(head) && toks.length === 1) {
        stmts.push({ k: head, line: line.n, raw: line.text });
        i++;
        continue;
      }
      if (head === "import" || head === "from") {
        // imports are left alone — never annotated through
        stmts.push({ k: "import", line: line.n, raw: line.text });
        i++;
        continue;
      }
      if (CONTROL_KW.has(head)) {
        // try/with/class/assert/raise/del/global/… — parsed as a control
        // statement we will not annotate through. Record it in the
        // manifest (REFUSE > GUESS) and, when it has a block, walk the
        // block so the declarations inside still get proved.
        const { body, next } = findBlock();
        stmts.push({ k: "opaque", reason: head + " — not analysed (py2cy types only scalars/counted loops)", line: line.n, raw: line.text, body: body || null });
        i = body ? next : i + 1;
        continue;
      }
      // assignment?  (target = expr, target op= expr)
      const ei = eqIndex(toks);
      if (ei > 0) {
        const lhsToks = toks.slice(0, ei), op = toks[ei].v, rhsToks = toks.slice(ei + 1);
        const parts = splitTopLevel(lhsToks);
        const names = parts.map((p) => (p.length === 1 && p[0].k === "name" ? p[0].v : null));
        const rhsParts = splitTopLevel(rhsToks);
        if (parts.length === rhsParts.length) {
          stmts.push({
            k: "assign", op,
            targets: names.map((n, k) => (n ? { name: n } : { other: tokText(parts[k]) })),
            values: rhsParts.map((r) => safeExpr(r)),
            line: line.n, raw: line.text,
          });
          i++;
          continue;
        }
        if (names.some((n) => n)) {
          stmts.push({ k: "assign", op, targets: names.map((n) => ({ name: n })), values: [safeExpr(rhsToks)], line: line.n, raw: line.text });
          i++;
          continue;
        }
      }
      // a bare call / expression statement — e.g. `main()`
      stmts.push({ k: "expr", expr: safeExpr(toks), line: line.n, raw: line.text });
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      stmts.push({ k: "opaque", reason: e.reason, line: line.n, raw: line.text });
    }
    i++;
  }
  return { stmts, i };
}

function tokText(toks) { return toks.map((t) => t.v).join(""); }

// render an expression AST back to a short source string (for evidence text)
function exprText(e) {
  if (!e) return "";
  switch (e.t) {
    case "num": return String(e.raw ?? e.v);
    case "str": return JSON.stringify(e.v);
    case "bool": return e.v;
    case "none": return "None";
    case "name": return e.v;
    case "list": return "[" + e.items.map(exprText).join(", ") + "]";
    case "unary": return e.op + exprText(e.a);
    case "bin": return "(" + exprText(e.a) + " " + e.op + " " + exprText(e.b) + ")";
    case "cmp": return exprText(e.a) + " " + e.op + " " + exprText(e.b);
    case "index": return e.baseName + "[" + (e.idx || []).map((x) => (x.slice ? ":" : exprText(x.e))).join(",") + "]";
    case "call": return e.fn + "(" + (e.args || []).map((a) => (a.e ? exprText(a.e) : "*")).join(", ") + ")";
    default: return e.text || "";
  }
}
function stripColon(s) { const t = s.trim(); return t.endsWith(":") ? t.slice(0, -1) : t; }
function parseParams(text) {
  const m = /\(([^)]*)\)/.exec(text);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return [];
  return inner.split(",").map((p) => p.trim().replace(/=.*$/, "")).filter(Boolean);
}
// parse an expression, returning a Refuse marker node on failure (so a
// single unprovable RHS does not lose the whole statement)
function safeExpr(toks) {
  try { return parseExpr(toks); }
  catch (e) { if (e instanceof Refuse) return { t: "unknown", reason: e.reason, text: tokText(toks) }; throw e; }
}

// ─── the analysis walk ──────────────────────────────────────────
// A scope-aware pass over the parsed module that (a) proves types and
// (b) emits the declarations. Proving and emitting are separate phases
// because a declaration may be needed before the flow that proves it
// (e.g. `h` is proved by the loop body, declared at the top of `main`).
function analyzeModule(module) {
  const A = new Annotator();
  // A.vars holds the FINAL per-scope type, keyed "scopename.varname"
  // ("" for module scope). The walk threads `env` (scope-local live map)
  // and mirrors every bind into A.vars so declarations can be built
  // after the whole flow is known (a loop counter is proved by its
  // body, but declared at the top of the function).
  const walk = (stmts, env, scope, widen) => {
    const put = (name, ty) => {
      // in fixpoint rounds (>1) a rebind WIDENS rather than overwrites:
      // the join is the loop invariant (monotone, so it terminates).
      const next = widen && env.has(name) ? joinTy(env.get(name), ty) : ty;
      env.set(name, next);
      A.vars.set((scope.name ? scope.name + "." : "") + name, next);
    };
    for (const st of stmts) {
      switch (st.k) {
        case "assign": {
          if (st.op !== "=") {
            // augmented assign `t OP= v` means `t = t OP v` — model the FULL
            // binop, not just the RHS. Joining the target with the bare RHS
            // under-approximates (`s += 100` ×3 is 300, not [0,100]) and can
            // even declare a wrapping C type; like Python, a `+=` on an
            // unbound name is unprovable (the name lookup yields Any).
            const bop = st.op.slice(0, -1);
            for (let k = 0; k < st.targets.length; k++) {
              const t = st.targets[k];
              const v = st.values[Math.min(k, st.values.length - 1)];
              if (t.name && v) put(t.name, A.typeOf({ t: "bin", op: bop, a: { t: "name", v: t.name }, b: v }, env));
            }
            break;
          }
          for (let k = 0; k < st.targets.length; k++) {
            const t = st.targets[k];
            const v = st.values[Math.min(k, st.values.length - 1)];
            if (!t.name) { A.refuse(st.line, "assign", "unprovable target (" + (t.other || "?") + ")"); continue; }
            const tv = A.typeOf(v, env);
            put(t.name, tv);
            if (tv.kind === "intlist" || tv.kind === "list") A.lists.add(t.name);
            if (tv.kind === "big") A.bigints.add(t.name);
            // remember WHICH proof bounded a modulo result: the value is
            // clamped by the modulus while the dividend needs a wider
            // intermediate — the rolling_hash `long long h` story.
            if (tv.kind === "int" && v && v.t === "bin" && v.op === "%") {
              const modN = v.b && v.b.t === "num" ? numVal(v.b.raw ?? v.b.v) : null;
              if (modN != null && tv.hi === modN - 1n) {
                A.notes.set((scope.name ? scope.name + "." : "") + t.name,
                  "`(" + exprText(v.a) + ") % " + exprText(v.b) + "`: the modulus bounds the value to [0," + tv.hi +
                  "], while `" + exprText(v.a) + "` needs the wider intermediate");
              }
            }
            // float modulo with a constant modulus: the same bounding story —
            // the value is clamped to the divisor's sign side, so the proof
            // table can name the modulus instead of a bare interval.
            if (tv.kind === "float" && v && v.t === "bin" && v.op === "%") {
              const mb = v.b && v.b.t === "num" ? floatVal(v.b.raw ?? v.b.v) : null;
              if (mb != null && mb !== 0) {
                A.notes.set((scope.name ? scope.name + "." : "") + t.name,
                  "`(" + exprText(v.a) + ") % " + exprText(v.b) + "`: the modulus bounds a finite float" +
                  (mb > 0 ? " to [0," + mb + "]" : " to [" + mb + ",0]"));
              }
            }
            scope.locals.add(t.name);
          }
          break;
        }
        case "for": {
          const it = st.iter;
          if (it && it.t === "call" && it.fn === "range") {
            // counted loop → the counter's range is the range() bound:
            // `for i in range(N)` gives i ∈ [0, N-1] (the rolling_hash
            // declaration, exactly as bench/cython/rolling_hash_typed.pyx).
            const bounds = rangeBounds(it.args, env, A);
            const trip = (bounds.lo != null && bounds.hi != null) ? bounds.hi - bounds.lo + 1n : null;
            // A SHORT counted loop (a constant trip count <= UNROLL_CAP, and
            // step 1 — so at most two range() args) is unrolled exactly:
            // running the body for every iteration gives the reachable range
            // (range(2) proves h ∈ [1,1]) instead of the [0,m-1] invariant.
            if (it.args.length <= 2 && trip != null && trip >= 0n && trip <= UNROLL_CAP) {
              const saved = A.exact;
              A.exact = true;
              // Unrolling is exact per iteration, but a declaration must cover
              // the variable's WHOLE life: accumulate the entry values and
              // every iteration's values. The last iteration alone would omit
              // the initial and intermediate values — an unsound proof, even
              // when the chosen C width happened to hold them.
              const acc = new Map(env);
              const scoped = (name) => (scope.name ? scope.name + "." : "") + name;
              for (let k = 0n; k < trip; k++) {
                put(st.target, intTy(bounds.lo + k, bounds.lo + k, bounds.need));
                walk(st.body, env, scope, false);
                for (const [name, ty] of env) {
                  const a = acc.get(name);
                  acc.set(name, a ? joinTy(a, ty) : ty);
                }
              }
              A.exact = saved;
              for (const [name, ty] of acc) {
                env.set(name, ty);
                A.vars.set(scoped(name), ty);
              }
            } else {
              put(st.target, intTy(bounds.lo, bounds.hi, bounds.need));
              const saved = A.exact;
              A.exact = false;               // the fixpoint needs the blanket %
              walkLoopBody(st.body, env, scope, walk, A);
              A.exact = saved;
            }
            put(st.target, intTy(bounds.lo, bounds.hi, bounds.need));
            // only a PROVED i64-exceeding bound is a bigint (GMP) case; an
            // unknown bound is simply unproven — the target stays a Python
            // object (correct, no win) and no GMP FFI is emitted.
            if (bounds.hi != null && (bounds.hi > U64_MAX || bounds.lo < I64_MIN)) A.bigints.add(st.target);
            scope.locals.add(st.target);
            scope.loops.push({ name: st.target, lo: bounds.lo, hi: bounds.hi, need: bounds.need, line: st.line });
          } else {
            const t = A.typeOf(it, env);
            if (t.kind === "floatlist") {
              const vt = { kind: "float", lo: t.lo, hi: t.hi };
              if (dyFits(t.dy)) vt.dy = t.dy;
              put(st.target, vt); scope.locals.add(st.target);
            }
            else if (t.kind === "intlist" || t.kind === "list") { put(st.target, intTy(t.lo, t.hi)); scope.locals.add(st.target); }
            else {
              put(st.target, ANY);
              A.refuse(st.line, "for", "loop iterator is not a provably-int range (element type unproven)", st.raw.trim());
            }
            const saved = A.exact;
            A.exact = false;
            walkLoopBody(st.body, env, scope, walk, A);
            A.exact = saved;
          }
          break;
        }
        case "while": {
          // Exact unroll of a short `while` when the trip count is provable
          // (see whileCounterGuard/tripCount). `acc` keeps the join of every
          // value seen: the declaration must cover the values used INSIDE
          // the loop, not just the post-loop one.
          const ug = whileCounterGuard(st.cond, env, A);
          if (ug && !hasEarlyExit(st.body)) {
            const ct = env.get(ug.name);
            const step = (ct && ct.kind === "int" && ct.lo != null && ct.lo === ct.hi) ? loopCounterStep(st.body, ug.name) : null;
            const trip = step ? tripCount(ct.lo, ug.op, ug.bound, step.delta) : null;
            if (trip != null && trip >= 0n && trip <= UNROLL_CAP) {
              const acc = new Map(env);
              const savedExact = A.exact;
              A.exact = true;
              let cur = ct.lo;
              for (let k = 0n; k < trip; k++) {
                put(ug.name, intTy(cur, cur, ct.need ?? 0n));
                walk(st.body, env, scope, false);
                for (const [n, tv] of env) { const a0 = acc.get(n); acc.set(n, a0 === undefined ? tv : joinTy(a0, tv)); }
                cur = cur + step.delta;
              }
              A.exact = savedExact;
              for (const [n, tv] of acc) { env.set(n, tv); A.vars.set((scope.name ? scope.name + "." : "") + n, tv); }
              scope.locals.add(ug.name);
              A.notes.set((scope.name ? scope.name + "." : "") + ug.name,
                "while guard `" + exprText(st.cond) + "` fixes the trip count (" + trip + " iteration" + (trip === 1n ? "" : "s") +
                ") — exact unroll, `" + ug.name + "` ∈ " + typeName(A.vars.get((scope.name ? scope.name + "." : "") + ug.name)));
              break;
            }
          }
          const saved = A.exact;
          A.exact = false;
          const guard = whileGuard(st.cond, env, A);
          walkLoopBody(st.body, env, scope, walk, A, guard);
          A.exact = saved;
          // record the guard as the evidence for a guard-derived counter
          if (guard) for (const name of guard.keys()) {
            const key = (scope.name ? scope.name + "." : "") + name;
            A.notes.set(key, "while guard `" + exprText(st.cond) + "` bounds the loop head ⇒ " + typeName(A.vars.get(key)));
          }
          break;
        }
        case "if": {
          // Branch join: each arm is analysed from the SAME pre-branch state
          // and the results are joined (plus the fall-through when there is
          // no else). Overwriting with the last-walked arm was unsound: for
          // `if c: x = 5000000000 else: x = 1` it declared `cdef int x`
          // although the runtime value can be 5e9 (and it is what let a
          // float arm hide an inexact one from the single-precision proof).
          const base = new Map(env);
          const arms = [];
          for (const b of st.branches) { const e = new Map(base); walk(b.body, e, scope, widen); arms.push(e); }
          if (st.elseBody) { const e = new Map(base); walk(st.elseBody, e, scope, widen); arms.push(e); }
          else arms.push(base);                       // fall-through is possible
          const names = new Set(base.keys());
          for (const e of arms) for (const k of e.keys()) names.add(k);
          for (const name of names) {
            let t = base.get(name);
            for (const e of arms) t = t === undefined ? e.get(name) : joinTy(t, e.get(name));
            env.set(name, t);
            A.vars.set((scope.name ? scope.name + "." : "") + name, t);
          }
          break;
        }
        case "def": {
          const sub = { name: st.name, locals: new Set(), loops: [], params: st.params, returns: null, line: st.line };
          const senv = new Map();
          for (const p of st.params) { senv.set(p, ANY); A.vars.set(st.name + "." + p, ANY); }
          walk(st.body, senv, sub, false);
          A.funcs.set(st.name, sub);
          env.set(st.name, ANY);
          break;
        }
        case "expr":
          if (st.expr && st.expr.t === "unknown") A.refuse(st.line, "expression", st.expr.reason || "unparsed expression", st.raw.trim());
          else if (st.expr && st.expr.t === "call" && st.expr.fn === "print") break;   // print(x) is fine
          break;
        case "opaque":
          A.refuse(st.line, "statement", st.reason || "unparsed statement", st.raw.trim());
          // a control statement (try/with/…) still has a block worth
          // walking: the declarations inside are provable even though the
          // statement itself is not annotated through.
          if (st.body) walk(st.body, env, scope, widen);
          break;
        default: break;
      }
    }
  };

  const top = { name: null, locals: new Set(), loops: [] };
  walk(module, new Map(), top, false);
  A.moduleScope = top;
  promoteBigintCounters(module, A);
  demoteUncoveredBigints(module, A);
  promoteListViews(module, A);
  demoteFloat32(module, A);
  return A;
}

// ─── the whole-program condition for `cdef float` ───────────────
// C promotes an operation to double only when SOME operand is double; if
// both operands are `float`, the op runs in binary32. Declaring a variable
// `float` therefore changes OTHER expressions (verified: `cdef float
// x=4097, y=4097; cdef double c = x*y` gives 16785408 while all-double gives
// 16785409). Exactness is thus a property of the program, not of a variable.
//
// A name keeps its dyadic proof only if every operation computed in binary32
// that involves it has an exact (dyadic) result; otherwise it is demoted to
// `double` — REFUSE > GUESS. Demotion only ever removes proofs, so the
// fixpoint is monotone and terminates.
function demoteFloat32(module, A) {
  const hasDy = (t) => !!(t && t.kind === "float" && t.dy);
  const isInt = (t) => !!(t && t.kind === "int");
  const isDoubleFloat = (t) => !!(t && t.kind === "float" && !t.dy);
  const keyOf = (scope, name) => (scope.name ? scope.name + "." : "") + name;
  const strip = (t) => (t && t.kind === "float") ? { kind: "float", lo: t.lo, hi: t.hi } : t;

  const envFor = (scope) => {
    const env = new Map();
    const f = scope.name ? A.funcs.get(scope.name) : null;
    const names = f ? [...(f.locals || []), ...(f.params || [])] : [...(scope.locals || [])];
    for (const n of names) { const t = A.vars.get(keyOf(scope, n)); if (t) env.set(n, t); }
    return env;
  };
  const collect = (e, acc) => {
    if (!e || typeof e !== "object") return acc;
    if (e.t === "name") acc.add(e.v);
    if (e.t === "list") for (const it of e.items || []) collect(it, acc);
    if (e.a) collect(e.a, acc);
    if (e.b) collect(e.b, acc);
    if (e.expr) collect(e.expr, acc);
    for (const x of e.idx || []) if (x.e) collect(x.e, acc);
    for (const a of e.args || []) if (a.e) collect(a.e, acc);
    return acc;
  };
  const mark = (e, scope, demote) => {
    for (const n of collect(e, new Set())) {
      const k = keyOf(scope, n);
      if (hasDy(A.vars.get(k))) demote.add(k);
    }
  };

  const scanExpr = (e, scope, env, demote) => {
    if (!e || typeof e !== "object") return;
    if (e.t === "list") for (const it of e.items || []) scanExpr(it, scope, env, demote);
    if (e.a) scanExpr(e.a, scope, env, demote);
    if (e.b) scanExpr(e.b, scope, env, demote);
    if (e.expr) scanExpr(e.expr, scope, env, demote);
    for (const x of e.idx || []) if (x.e) scanExpr(x.e, scope, env, demote);
    for (const a of e.args || []) if (a.e) scanExpr(a.e, scope, env, demote);
    if (e.t !== "bin") return;
    const ta = A.typeOf(e.a, env), tb = A.typeOf(e.b, env);
    if (isDoubleFloat(ta) || isDoubleFloat(tb)) return;         // a double operand forces the op
    const floatOp = (hasDy(ta) && (isInt(tb) || hasDy(tb))) || (hasDy(tb) && (isInt(ta) || hasDy(ta)));
    if (!floatOp) return;                                        // int/int or object arithmetic
    if (!hasDy(A.typeOf(e, env))) mark(e, scope, demote);
  };

  const scan = (stmts, scope, demote) => {
    const env = envFor(scope);
    for (const st of stmts) {
      if (!st) continue;
      if (st.k === "assign") {
        for (const v of st.values) scanExpr(v, scope, env, demote);
        if (st.op !== "=") for (const t of st.targets) if (t.name) scanExpr({ t: "bin", op: st.op.slice(0, -1), a: { t: "name", v: t.name }, b: st.values[0] }, scope, env, demote);
      } else if (st.k === "for") { scanExpr(st.iter, scope, env, demote); scan(st.body, scope, demote); }
      else if (st.k === "while") { scanExpr(st.cond, scope, env, demote); scan(st.body, scope, demote); }
      else if (st.k === "if") {
        for (const b of st.branches) { scanExpr(b.cond, scope, env, demote); scan(b.body, scope, demote); }
        if (st.elseBody) scan(st.elseBody, scope, demote);
      } else if (st.k === "def") { const f = A.funcs.get(st.name); if (f) scan(st.body, f, demote); }
      else if (st.k === "expr") { if (st.expr) scanExpr(st.expr, scope, env, demote); }
      else if (st.k === "return") { if (st.expr) scanExpr(st.expr, scope, env, demote); }
      else if (st.k === "opaque") { if (st.body) scan(st.body, scope, demote); }
    }
  };

  for (let round = 0; round < 32; round++) {
    const demote = new Set();
    scan(module, A.moduleScope, demote);
    if (!demote.size) break;
    for (const k of demote) A.vars.set(k, strip(A.vars.get(k)));
  }
}

// Typed-memoryview promotion for read-only int lists (v1).
// A module-scope `arr = [<ints>]` becomes a buffer (`array`) + typed
// memoryview iff: exactly one assignment (the literal), a proved element
// range fitting a C int width, and EVERY other mention is `for v in arr`
// (iteration only — no indexing, len(), print, methods, passing, or defs).
// Anything else blocks promotion (safe), so the emitted view can never
// observe a list-only operation. Module scope only.
function promoteListViews(module, A) {
  for (const st of module) {
    if (!st || st.k !== "assign" || st.op !== "=" || !st.targets || st.targets.length !== 1) continue;
    const t = st.targets[0];
    if (!t.name) continue;
    const v = t.name;
    const val = st.values[Math.min(0, st.values.length - 1)];
    if (!val || val.t !== "list") continue;
    const ty = A.vars.get(v);
    if (!ty) continue;
    let vw = null;
    if (ty.kind === "intlist" && ty.lo != null && ty.hi != null) vw = viewTypeForRange(ty.lo, ty.hi);
    else if (ty.kind === "floatlist" && Number.isFinite(ty.lo) && Number.isFinite(ty.hi)) vw = { code: "f", view: "float[:]" };
    if (!vw) continue;
    if (countAssignments(module, v) !== 1) continue;
    if (!listViewCovered(module, v, st)) continue;
    const text = spliceArrayCtor(st.raw, v, vw.code);
    if (!text) continue;
    A.listViews.set(v, { typecode: vw.code, view: vw.view, line: st.line, text });
    A.notes.set(v, ty.kind === "floatlist"
      ? "homogeneous binary32-exact float list, only iterated — converted to a buffer (array('f')) + typed memoryview float[:]; elements ∈ [" + ty.lo + "," + ty.hi + "]"
      : "homogeneous int list, only iterated — converted to a buffer (array) + typed memoryview " + vw.view + "; elements ∈ [" + ty.lo + "," + ty.hi + "]");
  }
}

// the C item width for a proved element range. Narrowest sound width,
// always (a large u8 view is 4x the density of `int[:]` — footprint is the
// point of fixing the width, so there is no minimum-size cutoff).
// Unsigned when the range is non-negative (it doubles the positive range at
// the same size); signed otherwise. `long long` stays the 64-bit workhorse
// and u64 (`'Q'`) is the >i64 escape — reachable now that scalars have the
// u64 tier. There is deliberately no u128: no 16-byte array typecode exists
// and Cython has no __int128 view dtype (GMP stays right beyond u64, and it
// is scalar-only, so a beyond-64-bit list cannot be a C sequence at all).
function viewTypeForRange(lo, hi) {
  const U8 = 256n, U16 = 65536n, U32 = 4294967296n, U64 = 2n ** 64n;
  const I8 = 128n, I16 = 32768n, I32 = 2147483648n, I64 = 2n ** 63n;
  if (lo >= 0n) {
    if (hi < U8) return { code: "B", view: "unsigned char[:]" };
    if (hi < U16) return { code: "H", view: "unsigned short[:]" };
    if (hi < U32) return { code: "I", view: "unsigned int[:]" };
    if (hi < I64) return { code: "q", view: "long long[:]" };
    if (hi < U64) return { code: "Q", view: "unsigned long long[:]" };
    return null;
  }
  if (lo >= -I8 && hi < I8) return { code: "b", view: "signed char[:]" };
  if (lo >= -I16 && hi < I16) return { code: "h", view: "short[:]" };
  if (lo >= -I32 && hi < I32) return { code: "i", view: "int[:]" };
  if (lo >= -I64 && hi < I64) return { code: "q", view: "long long[:]" };
  return null;
}

function countAssignments(stmts, name) {
  let n = 0;
  const walkStmts = (ss) => {
    for (const st of ss) {
      if (!st) continue;
      if (st.k === "assign" && st.targets) {
        for (const t of st.targets) if (t.name === name) n++;
      }
      if (st.k === "if") {
        for (const b of st.branches) walkStmts(b.body);
        if (st.elseBody) walkStmts(st.elseBody);
      } else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) {
        if (st.target === name) n++;   // `for <name> in ...` rebinds it
        walkStmts(st.body);
      } else if (st.k === "def" && Array.isArray(st.body)) {
        walkStmts(st.body);
      }
    }
  };
  walkStmts(stmts);
  return n;
}

// every mention of `v` must be the defining literal or a `for x in v` header;
// all other statements must not mention `v` (checked on source text, so an
// unmodelled use fails safe). Bodies are recursed into.
function listViewCovered(module, v, defSt) {
  const check = (stmts) => {
    for (const st of stmts) {
      if (st === defSt) continue;
      if (st.k === "for" && st.iter && st.iter.t === "name" && st.iter.v === v) {
        if (!check(st.body)) return false;   // header allowed; body must be clean
        continue;
      }
      if (stmtRawMentions(st, v)) return false;
      if (st.k === "if") {
        for (const b of st.branches) if (!check(b.body)) return false;
        if (st.elseBody && !check(st.elseBody)) return false;
      } else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) {
        if (!check(st.body)) return false;
      } else if (st.k === "def" && Array.isArray(st.body)) {
        if (!check(st.body)) return false;
      }
    }
    return true;
  };
  return check(module);
}

// rewrite `arr = [...]` to `arr = array('<code>', [...])` on the raw source
// line. Returns null unless it is a clean top-level `=` (never `==`, `+=`, …).
function spliceArrayCtor(raw, name, code) {
  if (!raw) return null;
  const idx = raw.indexOf("=");
  if (idx < 0) return null;
  const prev = idx > 0 ? raw[idx - 1] : "";
  const next = idx + 1 < raw.length ? raw[idx + 1] : "";
  if (prev === "=" || prev === "!" || prev === "<" || prev === ">" || prev === "+" || prev === "-" || prev === "*" || prev === "/" || prev === "%" || prev === "&" || prev === "|" || prev === "^" || next === "=") return null;
  const lhs = raw.slice(0, idx).trimEnd();
  const rhs = raw.slice(idx + 1).trimStart();
  if (lhs !== name || !rhs.startsWith("[")) return null;
  return lhs + " = array('" + code + "', " + rhs + ")";
}

// BigInt-tier promotion for while-counters with a huge guard bound.
// If `while v < K` (or <=) can let v exceed i64, an i64 C type would wrap —
// the sound C choice is mpz_t, PROVIDED every statement touching v is
// GMP-rewritable (verified by trial below, never by trust). Otherwise v
// stays refused. Module scope only: guard temps need top-level init/clear.
function promoteBigintCounters(module, A) {
  for (const st of module) {
    if (!st || st.k !== "while" || !st.cond || !st.body) continue;
    const info = bigintGuardInfo(st.cond);
    if (!info) continue;
    const v = info.var;
    const needBig = info.op === "<" ? info.bound - 1n > U64_MAX
      : info.op === "<=" ? info.bound > U64_MAX
      : false;
    if (!needBig) continue;
    const t = A.vars.get(v);
    if (!t || (t.kind !== "int" && t.kind !== "any")) continue;
    const bigs = [...new Set([...A.bigints, v])];
    if (!bigintCounterCovered(module, v, st, bigs)) continue;
    A.vars.set(v, BIG);
    A.bigints.add(v);
    A.unstable.delete(v);
    A.notes.set(v, "while guard `" + exprText(st.cond) + "` lets `" + v + "` exceed i64 — Cython has no big-int, so the GMP FFI tier is emitted (guard + updates rewritten to mpz_* calls)");
  }
}

// the guard shape that can force the GMP tier: `<var> <OP> <literal>` with
// a constant bound (flipped `K <OP> <var>` normalized). Only `<`/`<=`, the
// bounds that let a growing counter exceed i64.
function bigintGuardInfo(cond) {
  if (!cond || cond.t !== "cmp") return null;
  const { a, b, op } = cond;
  let vname = null, bound = null, eop = op;
  if (a && a.t === "name") { vname = a.v; bound = litOf(b); }
  else if (b && b.t === "name") { vname = b.v; bound = litOf(a); eop = flipOp(op); }
  if (!vname || bound == null) return null;
  if (eop !== "<" && eop !== "<=") return null;
  return { var: vname, op: eop, bound };
}

// Verify-by-trial that promoting `v` cannot emit a half-translated file:
// every statement mentioning `v` must either rewrite (checked with the
// REAL rewriter against a throwaway A) or not mention `v` at all. Compound
// statements are recursed into; a rewritten statement is not recursed into
// (it is replaced wholesale, exactly as the collector does).
function bigintCounterCovered(module, v, loopSt, bigs) {
  const dummy = { refuse() {} };
  if (!rewriteBigintGuard(loopSt, bigs)) return false;   // the promoted guard itself must translate
  const mentions = (st) => stmtRawMentions(st, v);
  const check = (stmts) => {
    for (const st of stmts) {
      if (st === loopSt) {
        if (!check(st.body)) return false;
        continue;
      }
      if (rewriteBigintStmt(st, bigs, dummy)) continue;
      if (st.k === "if" || st.k === "while") {
        if (rewriteBigintGuard(st, bigs)) {
          if (st.k === "if") {
            for (const b of st.branches) if (!check(b.body)) return false;
            if (st.elseBody && !check(st.elseBody)) return false;
          } else if (Array.isArray(st.body) && !check(st.body)) return false;
          continue;
        }
        if (mentions(st)) return false;
        if (st.k === "if") {
          for (const b of st.branches) if (!check(b.body)) return false;
          if (st.elseBody && !check(st.elseBody)) return false;
        } else if (Array.isArray(st.body) && !check(st.body)) return false;
        continue;
      }
      if (mentions(st)) return false;
      if (st.k === "for" && Array.isArray(st.body)) { if (!check(st.body)) return false; }
      else if (st.k === "def" && Array.isArray(st.body)) { if (!check(st.body)) return false; }
    }
    return true;
  };
  return check(module);
}

// conservative mention check on the statement's own source line (every use
// of a name appears in some statement's raw text; unknown shapes fail safe)
function stmtRawMentions(st, name) {
  if (!st || !st.raw) return true;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + esc + "\\b").test(st.raw);
}

// Is every statement that mentions bigint `v` expressible in the emitted GMP
// FFI? A proven BigInt whose use is NOT rewritable must NOT be declared
// `cdef mpz_t`: the untranslated line would sit next to an mpz_t variable and
// the .pyx would not compile. Mirrors collectBigintRewrites' traversal — a
// rewritten statement is not recursed into, a guard is rewritten separately,
// and anything else that still mentions `v` fails.
function bigintCovered(stmts, v, bigs) {
  const dummy = { refuse() {} };
  const mentions = (st) => stmtRawMentions(st, v);
  for (const st of stmts) {
    if (rewriteBigintStmt(st, bigs, dummy)) continue;
    if ((st.k === "while" || st.k === "if") && rewriteBigintGuard(st, bigs)) {
      // guard rewritten — the body is still checked below
    } else if (mentions(st)) {
      return false;
    }
    if (st.k === "if") {
      for (const b of st.branches) if (Array.isArray(b.body) && !bigintCovered(b.body, v, bigs)) return false;
      if (st.elseBody && !bigintCovered(st.elseBody, v, bigs)) return false;
    } else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) {
      if (!bigintCovered(st.body, v, bigs)) return false;
    } else if (st.k === "def" && Array.isArray(st.body)) {
      if (!bigintCovered(st.body, v, bigs)) return false;
    }
  }
  return true;
}

// A BigInt the rewriter cannot fully lower is demoted to a Python object
// (REFUSE > GUESS) — otherwise the renderer emits `cdef mpz_t v` beside a
// verbatim Python expression and the .pyx fails to compile. This is the
// general guard behind the bignum_mul shapes: those happen to be rewritable,
// an arbitrary bigint accumulator is not.
function demoteUncoveredBigints(module, A) {
  for (const v of [...A.bigints]) {
    const t = A.vars.get(v);
    if (!t || t.kind !== "big") continue;              // function-scoped names are keyed differently
    const bigs = [...new Set([...A.bigints, v])];
    if (bigintCovered(module, v, bigs)) continue;
    A.bigints.delete(v);
    A.vars.set(v, ANY);
    A.unstable.delete(v);
    // the declaration pass records ONE refusal, using this as the reason
    A.notes.set(v, "bigint `" + v + "` is not fully expressible in the emitted GMP FFI (a line touching it is not rewritable), so it stays exact Python (REFUSE > GUESS)");
  }
}

// A loop body is analysed to a FIXPOINT by monotone widening: a
// loop-carried variable is typed from its own previous iteration, so one
// pass is not enough. `h = (h*31 + i) % M` needs the second pass to see
// that `h` is in [0, M-1] on entry to `h*31` — which is what forces the
// 64-bit width.
//
// Widening only grows ranges, so most loops settle. A loop whose range
// grows without bound (`while i < N: i += 1` with no proved N) never
// reaches a fixpoint; keeping the last iterate would emit a C type far
// too narrow (the `while i < 10**55` → `Int[1,8]` soundness bug). So once
// the budget is spent, the still-growing names are widened to ANY
// (unprovable) — REFUSE > GUESS. ANY absorbs in joinTy, so this settles.
const LOOP_NARROW_ROUNDS = 6;

// Guard refinement: a `while` condition bounds the loop-head values. For
// `while x < K` the head always has x ∈ [.., K-1], so the head range can be
// clamped before each body pass — that is what turns `while i < 100: i += 1`
// from an unconverging widening into the proof i ∈ [0,100]. Only a single
// comparison against a PROVED i64 int is used (a bigint bound is not an i64
// range, so it gets no guard and is refused as before).
function flipOp(op) {
  return { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==" }[op] || op;
}
function whileGuard(cond, env, A) {
  if (!cond || cond.t !== "cmp") return null;
  const { a, b, op } = cond;
  let name = null, c = null, flipped = false;
  if (a && a.t === "name" && b) { name = a.v; c = A.typeOf(b, env); }
  else if (b && b.t === "name" && a) { name = b.v; c = A.typeOf(a, env); flipped = true; }
  if (!name || !c || c.kind !== "int" || c.lo == null || c.hi == null) return null;
  const eop = flipped ? flipOp(op) : op;
  const g = { lo: null, hi: null };
  if (eop === "<") g.hi = c.hi - 1n;
  else if (eop === "<=") g.hi = c.hi;
  else if (eop === ">") g.lo = c.lo + 1n;
  else if (eop === ">=") g.lo = c.lo;
  else if (eop === "==") { g.lo = c.lo; g.hi = c.hi; }
  else return null;
  return new Map([[name, g]]);
}

// ─── exact unrolling of a SHORT while loop ──────────────────────
// A `for … range(…)` has an explicit trip count; a `while` does not, so it
// normally goes through the widening fixpoint — which refuses any growing
// loop-carried value (`x = x * 3` never converges), even when the guard
// makes the loop run twice. But when the guard compares a counter against a
// CONSTANT and the body updates that counter unconditionally by a nonzero
// constant from a provably EXACT value, the counter sequence is exact and
// the guard is monotone — so the trip count is exact, and the body can be
// unrolled exactly (sound, no widening).
function ceilDivBig(a, b) { return a <= 0n ? 0n : (a + b - 1n) / b; }

// body executions before `guard` first fails, or null when unknown
function tripCount(start, op, bound, delta) {
  if (delta === 0n) return null;
  if ((op === "<" || op === "<=") && delta > 0n) {
    const gap = bound - start;
    return op === "<" ? ceilDivBig(gap, delta) : (gap < 0n ? 0n : gap / delta + 1n);
  }
  if ((op === ">" || op === ">=") && delta < 0n) {
    const d = -delta, gap = start - bound;
    return op === ">" ? ceilDivBig(gap, d) : (gap < 0n ? 0n : gap / d + 1n);
  }
  return null;
}

// the constant step `x OP= k` / `x = x ± k` applies, or null
function counterDelta(op, v, name) {
  if (op === "+=" || op === "-=") { const k = litOf(v); if (k == null) return null; return op === "+=" ? k : -k; }
  if (op !== "=" || !v || v.t !== "bin") return null;
  const an = v.a && v.a.t === "name" && v.a.v === name;
  const bn = v.b && v.b.t === "name" && v.b.v === name;
  if (v.op === "+") { if (an) return litOf(v.b); if (bn) return litOf(v.a); return null; }
  if (v.op === "-") { if (an) { const k = litOf(v.b); return k == null ? null : -k; } return null; }
  return null;
}

// the body's single unconditional constant step on `name`, or null. A
// conditional/nested update, a second assignment, or an unrecognised shape
// all return null (the caller then falls back to the widening fixpoint).
function loopCounterStep(body, name) {
  let delta = null, count = 0, bad = false;
  const scan = (stmts, top) => {
    for (const st of stmts) {
      if (st.k === "assign") {
        for (let k = 0; k < st.targets.length; k++) {
          if (st.targets[k].name !== name) continue;
          count++;
          if (!top) { bad = true; continue; }
          const d = counterDelta(st.op, st.values[Math.min(k, st.values.length - 1)], name);
          if (d == null) bad = true; else delta = d;
        }
      } else if (st.k === "if") {
        for (const b of st.branches) scan(b.body, false);
        if (st.elseBody) scan(st.elseBody, false);
      } else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) scan(st.body, false);
      else if (st.k === "def" && Array.isArray(st.body)) scan(st.body, false);
    }
  };
  scan(body, true);
  return (bad || count !== 1 || delta == null) ? null : { delta };
}

// a break/continue/return can leave the loop early, making the computed
// trip count wrong — refuse to unroll those.
function hasEarlyExit(stmts) {
  for (const st of stmts) {
    if (!st) continue;
    if (st.k === "break" || st.k === "continue" || st.k === "return") return true;
    if (st.k === "if") { for (const b of st.branches) if (hasEarlyExit(b.body)) return true; if (st.elseBody && hasEarlyExit(st.elseBody)) return true; }
    else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) { if (hasEarlyExit(st.body)) return true; }
    else if (st.k === "def" && Array.isArray(st.body)) { if (hasEarlyExit(st.body)) return true; }
    else if (st.k === "opaque" && st.body && hasEarlyExit(st.body)) return true;
  }
  return false;
}

// `while <counter> OP <constant>` with the counter on either side, or null
function whileCounterGuard(cond, env, A) {
  if (!cond || cond.t !== "cmp") return null;
  const { a, b, op } = cond;
  let name = null, bound = null, eop = op;
  if (a && a.t === "name" && b) { name = a.v; const t = A.typeOf(b, env); if (t.kind === "int" && t.lo != null && t.lo === t.hi) bound = t.lo; }
  else if (b && b.t === "name" && a) { name = b.v; const t = A.typeOf(a, env); if (t.kind === "int" && t.lo != null && t.lo === t.hi) bound = t.lo; eop = flipOp(op); }
  if (!name || bound == null) return null;
  if (!["<", "<=", ">", ">="].includes(eop)) return null;
  return { name, op: eop, bound };
}

// A loop body is analysed to a fixpoint. `guard` (optional) constrains the
// loop-head range of the named variables. `head` is the head invariant; `acc`
// accumulates every value seen (head + body) and is the DECLARED range, since
// the guard no longer holds once the loop exits. If the budget runs out, a
// guard-constrained name is widened to its guard bound; anything still
// growing is widened to ANY (unprovable). Keeping the last under-approximation
// would be unsound (the `while i < 10**55` → Int[1,8] bug).
function walkLoopBody(body, env, scope, walkFn, A, guard) {
  const keyOf = (name) => (scope.name ? scope.name + "." : "") + name;
  const sig = (v) => [v && v.kind, v && v.lo, v && v.hi, v && v.need].map((x) => (typeof x === "bigint" ? x.toString() : x)).join("|");
  const clamp = (m) => {
    if (!guard) return;
    for (const [name, g] of guard) {
      const t = m.get(name);
      if (!t || t.kind !== "int") continue;
      const lo = g.lo == null ? t.lo : (t.lo == null ? g.lo : (t.lo > g.lo ? t.lo : g.lo));
      const hi = g.hi == null ? t.hi : (t.hi == null ? g.hi : (t.hi < g.hi ? t.hi : g.hi));
      m.set(name, intTy(lo, hi, t.need));
    }
  };
  const head = new Map(env);
  const acc = new Map(env);
  clamp(head);
  let prev = new Map([...head].map(([k, v]) => [k, sig(v)]));
  for (let round = 0; round < 64; round++) {
    const work = new Map(head);
    walkFn(body, work, scope, /*widen*/ round > 0);
    for (const [k, v] of work) {
      const h = head.get(k);
      head.set(k, h ? joinTy(h, v) : v);
      const a2 = acc.get(k);
      acc.set(k, a2 ? joinTy(a2, v) : v);
    }
    clamp(head);
    const now = new Map([...head].map(([k, v]) => [k, sig(v)]));
    const grew = [...now].filter(([k, s]) => prev.get(k) !== s).map(([k]) => k);
    if (grew.length === 0) break;                    // fixpoint reached
    if (round >= LOOP_NARROW_ROUNDS) {
      for (const k of grew) {
        const v = head.get(k);
        if (!v || v === ANY) continue;
        const g = guard && guard.get(k);
        if (v.kind === "int" && g) {
          const lo = g.lo != null ? g.lo : v.lo;
          const hi = g.hi != null ? g.hi : v.hi;
          head.set(k, intTy(lo, hi, v.need));
        } else if (v.kind === "int" || v.kind === "float") {
          // Still growing after the budget: no closed proof. Ints widen to
          // Any (a C type would wrap); floats widen to Any for the same
          // reason (a C double is only exact when finiteness is proved — an
          // unbounded accumulation has no finite proof). REFUSE > GUESS.
          head.set(k, ANY);
          if (A) { A.vars.set(keyOf(k), ANY); A.unstable.add(keyOf(k)); }
        }
      }
    }
    prev = new Map([...head].map(([k, v]) => [k, sig(v)]));
  }
  for (const [k, v] of acc) {
    env.set(k, v);
    if (A) A.vars.set(keyOf(k), v);
  }
}

// a literal (or literal-derived) value outside i64 → the GMP tier (§1b)
function isBigLiteral(expr) {
  if (!expr) return false;
  switch (expr.t) {
    case "num": { const v = numVal(expr.raw ?? expr.v); return v != null && (v > U64_MAX || v < I64_MIN); }
    case "bin":
      if (expr.op === "**") {
        const b = expr.a, e = expr.b;
        const bv = b && b.t === "num" ? numVal(b.raw ?? b.v) : null;
        const ev = e && e.t === "num" ? numVal(e.raw ?? e.v) : null;
        if (bv != null && ev != null && ev >= 0n && ev < 4096n) {
          const v = bv ** ev;
          return v > U64_MAX || v < I64_MIN;
        }
      }
      return isBigLiteral(expr.a) || isBigLiteral(expr.b);
    case "unary": return isBigLiteral(expr.a);
    default: return false;
  }
}

// Proven [lo,hi] of a `range(...)` call (nulls = unbounded/unknown).
function rangeBounds(args, env, A) {
  const val = (a) => {
    if (!a || !a.e) return null;
    const t = A.typeOf(a.e, env);
    if (t.kind === "int" && t.lo != null && t.hi != null && t.lo === t.hi) return t.lo;
    return null;
  };
  const nums = args.filter((a) => a.e).map(val);
  const needOf = (a) => {
    if (!a || !a.e) return 0n;
    const t = A.typeOf(a.e, env);
    if (t.kind !== "int") return 0n;   // floats/bigints have no i64 `need`
    return maxBig([t.need ?? 0n, t.hi == null ? 0n : absBig(t.hi)]);
  };
  const need = maxBig(args.map(needOf));
  if (args.length === 1) {
    const n = nums[0];
    if (n == null) return { lo: 0n, hi: null, need };
    if (n <= 0n) return { lo: 0n, hi: null, need };
    return { lo: 0n, hi: n - 1n, need };
  }
  if (args.length >= 2) {
    const s = nums[0], e = nums[1];
    if (s != null && e != null && e >= s) return { lo: s, hi: e - 1n, need };
    return { lo: s, hi: null, need };
  }
  return { lo: null, hi: null, need };
}

// ─── output: prove → declare ────────────────────────────────────
// annotate(source, opts) is the whole tool. opts:
//   mode: "pure" (default, §5 mode 2) | "pyx" (§5 mode 1)
//   gmp:  force the GMP FFI block when a bigint is proved (default auto)
// Returns { text, mode, decls, refusals, stats, proof }.
export function annotate(source, opts = {}) {
  const mode = opts.mode === "pyx" ? "pyx" : "pure";
  const lines = lexLines(source);
  const { stmts } = parseBlock(lines, 0, lines.length);
  const A = analyzeModule(stmts);

  const decls = buildDecls(A, mode, opts);
  const text = mode === "pyx"
    ? renderPyx(source, stmts, A, decls, opts)
    : renderPure(source, stmts, A, decls, opts);

  const stats = {
    lines: lines.filter((l) => !l.blank).length,
    declared: [...decls.module, ...decls.functions.flatMap((f) => [...f.locals])].length,
    typed: decls.module.size + decls.functions.reduce((s, f) => s + f.localCount, 0),
    refusals: A.refusals.length,
    bigint: A.bigints.size,
    gmp: decls.gmp,
  };
  return { text, mode, decls: summarizeDecls(decls), refusals: A.refusals, stats, proof: A };
}

export const annotateCython = annotate;

// choose declarations per scope from the proved types
function buildDecls(A, mode, opts) {
  const ct = mode === "pyx";
  const module = [];
  const functions = [];

  // module scope: vars proved at top level (key prefix "")
  for (const name of A.moduleScope.locals) {
    const t = A.vars.get(name);
    if (!t || t.kind === "any") { A.refuseAtModule(name); continue; }
    if (t.kind === "intlist" && A.listViews.has(name)) {
      const vw = A.listViews.get(name);
      module.push({ name, ty: "SeqInt[" + t.lo + "," + t.hi + "]", ctype: vw.view, kind: "view", typecode: vw.code, line: vw.line, why: A.notes.get(name) || ("typed memoryview " + vw.view) });
      continue;
    }
    if (t.kind === "floatlist" && A.listViews.has(name)) {
      const vw = A.listViews.get(name);
      module.push({ name, ty: "Float32List", ctype: vw.view, kind: "view", typecode: vw.code, line: vw.line, why: A.notes.get(name) || ("typed memoryview " + vw.view) });
      continue;
    }
    const d = declFor(name, t, A.bigints.has(name), A.notes.get(name));
    if (d) {
      const lp = (A.moduleScope.loops || []).find((l) => l.name === name);
      if (lp && lp.lo != null && lp.hi != null) d.why = "counted-loop counter: `for " + name + " in range(...)` ⇒ [" + lp.lo + "," + lp.hi + "]";
      module.push(d);
    } else A.refuseAtModule(name, t);
  }
  for (const [fname, f] of A.funcs) {
    const locals = [];
    for (const name of f.locals) {
      if (f.params.includes(name)) continue;          // params carry no cdef here
      const t = A.vars.get(fname + "." + name);
      if (!t || t.kind === "any") continue;
      const d = declFor(name, t, A.bigints.has(name), A.notes.get(fname + "." + name));
      if (d) {
        const lp = f.loops.find((l) => l.name === name);
        if (lp && lp.lo != null && lp.hi != null) d.why = "counted-loop counter: `for " + name + " in range(...)` ⇒ [" + lp.lo + "," + lp.hi + "]";
        locals.push(d);
      } else A.refuseAtModule(name, t, fname);
    }
    // a counted loop counter is proved by its bound even if the body never
    // assigns it — the canonical rolling_hash `cdef long long i`. An
    // unproved bound is NOT declared (REFUSE > GUESS).
    for (const lp of f.loops) {
      if (locals.some((l) => l.name === lp.name)) continue;
      if (lp.hi == null || lp.lo == null) { A.refuse(lp.line, "loop counter", "bound of `" + lp.name + "` not provable — left as a Python object", "for " + lp.name + " in range(...)"); continue; }
      locals.push({ name: lp.name, ty: "Int[" + lp.lo + "," + lp.hi + "]", ctype: cTypeForRange(lp.lo, lp.hi, lp.need), kind: "int", loop: true, why: "counted-loop counter: `for " + lp.name + " in range(...)` ⇒ [" + lp.lo + "," + lp.hi + "]" });
    }
    functions.push({ name: fname, locals, params: f.params, localCount: locals.length });
  }
  // module-level counted loops (the rolling_hash shape has no def)
  for (const lp of A.moduleScope.loops || []) {
    if (module.some((m) => m.name === lp.name)) continue;
    if (lp.hi == null || lp.lo == null) { A.refuse(lp.line, "loop counter", "bound of `" + lp.name + "` not provable — left as a Python object", "for " + lp.name + " in range(...)"); continue; }
    module.push({ name: lp.name, ty: "Int[" + lp.lo + "," + lp.hi + "]", ctype: cTypeForRange(lp.lo, lp.hi, lp.need), kind: "int", loop: true, why: "counted-loop counter: `for " + lp.name + " in range(...)` ⇒ [" + lp.lo + "," + lp.hi + "]" });
  }
  const gmp = A.bigints.size > 0 && opts.gmp !== false;
  return { module, functions, gmp, pyx: ct };
}

// one declaration from a proved type (null = nothing to declare)
function declFor(name, t, big, why) {
  if (t.kind === "str") return { name, ty: "Str", ctype: "str", kind: "str", why: why || "proved `str` (no numeric C type to win)" };
  if (t.kind === "big") return { name, ty: "BigInt", ctype: "mpz_t", kind: "bigint", big: true, why: why || "value exceeds i64 — Cython has no native big-int, so the GMP FFI tier is emitted" };
  if (t.kind === "int") {
    // THE PROOF RULE (AUTO_CYTHON §6): a C type is emitted only when the
    // value's range is PROVED. An unbounded int is not a `long long` —
    // that would be a guess that wraps silently. It stays a Python object.
    if (t.lo == null || t.hi == null) return null;
    const ctype = big ? "mpz_t" : cTypeForRange(t.lo, t.hi, t.need);
    return { name, ty: typeName(t), ctype, kind: big ? "bigint" : "int", big, why: why || intEvidence(t, ctype) };
  }
  if (t.kind === "float") {
    // THE FLOAT RULE: a C double is emitted only for a PROVED-finite float.
    // CPython float and C double agree on + - * / % for finite operands
    // (same IEEE-754 round-to-nearest; ZeroDivisionError on both sides),
    // so finiteness + the operator allowlist in floatBinType IS the proof.
    // With a dyadic proof the value is exactly binary32 too, so the narrower
    // `cdef float` is exact; without one it must stay `cdef double`.
    if (t.lo == null || t.hi == null || !Number.isFinite(t.lo) || !Number.isFinite(t.hi)) return null;
    if (t.dy) return { name, ty: "Float32[" + t.lo + "," + t.hi + "]", ctype: "float", kind: "float", why: why || ("binary32-exact float ∈ [" + t.lo + "," + t.hi + "]: every value is m·2^-s with |m| ≤ 2^24, so single precision rounds nothing (CPython bit-for-bit) → float") };
    return { name, ty: "Float[" + t.lo + "," + t.hi + "]", ctype: "double", kind: "float", why: why || ("proved finite float ∈ [" + t.lo + "," + t.hi + "] → double") };
  }
  if (t.kind === "intlist") return { name, ty: "SeqInt[" + (t.lo ?? "?") + "," + (t.hi ?? "?") + "]", ctype: "list", kind: "list", why: why || ("proved an int list; elements ∈ [" + (t.lo ?? "?") + "," + (t.hi ?? "?") + "]") };
  if (t.kind === "floatlist") return { name, ty: "Float32List", ctype: "list", kind: "list", why: why || ("proved a binary32-exact float list; elements ∈ [" + (t.lo ?? "?") + "," + (t.hi ?? "?") + "]") };
  if (t.kind === "list") return { name, ty: "list", ctype: "list", kind: "untyped-list", why: why || "a list whose element type was not proved — kept a Python list" };
  return null;
}

// the evidence behind a proved integer range: the value range, plus the
// intermediate width whenever that is what forced a wider C type.
function intEvidence(t, ctype) {
  const range = "value ∈ [" + t.lo + "," + t.hi + "]";
  const valueMag = maxBig([absBig(t.lo), absBig(t.hi)]);
  if (t.need != null && t.need > valueMag) {
    return range + "; the widest intermediate in its definition reaches " + t.need +
      " (wider than the value), which is why the C type is " + ctype;
  }
  return range + " proved by the interval analysis → " + ctype;
}

function summarizeDecls(decls) {
  const out = [];
  for (const d of decls.module) out.push({ scope: "module", ...d });
  for (const f of decls.functions) for (const l of f.locals) out.push({ scope: f.name, ...l });
  return out;
}

// Annotator helper used above (kept off the class to avoid widening its API).
Annotator.prototype.refuseAtModule = function (name, t, scope) {
  const where = scope ? "`" + scope + "()`" : "module scope";
  const key = (scope ? scope + "." : "") + name;
  const why = this.notes && this.notes.has(key)
    ? this.notes.get(key)
    : this.unstable && this.unstable.has(key)
      ? "the loop-carried value did not converge (the loop may run longer than the widening budget can prove) — a C type would be a guess that wraps"
      : !t || t.kind === "any"
        ? "type not provable"
        : t.kind === "float"
          ? "value is a float whose finiteness was not proved — a C double would diverge from Python on overflow/zero-division"
          : "value is an unproved int (no range) — a C type would be a guess that wraps";
  this.refuse(null, "declaration", "type of `" + name + "` in " + where + " " + why + " — left as a Python object", name + "@" + (scope || "module"));
};

// ─── renderer: pure-Python mode (§5 mode 2) ─────────────────────
// The output STAYS valid, runnable Python: `import cython`, a
// `@cython.locals(...)` decorator per function, and `cython.declare`
// for module-scope names. An unproved name is simply not declared.
function renderPure(source, stmts, A, decls, opts) {
  const lines = lexLines(source);
  const out = [];
  const useGlobals = decls.module.length > 0;
  out.push("# cython: language_level=3, boundscheck=False, wraparound=False, cdivision=False");
  out.push("#");
  out.push("# Generated by py2cy (auto-typed Cython — pure-Python mode).");
  out.push("# The file is still valid, runnable Python: cython.declare / @cython.locals");
  out.push("# are inert without the Cython compiler.");
  out.push("#");
  if (A.bigints.size) {
    out.push("# bigint variables were proved: " + [...A.bigints].join(", "));
    out.push("#   Cython has no native big-int — see the GMP FFI block in the .pyx form");
    out.push("#   (py2cy --mode pyx) for the tier the C backend uses.");
  }
  out.push("import cython");
  out.push("");
  if (useGlobals) {
    out.push("# module-scope declarations (proved by the flow analysis)");
    out.push("cython.declare(" + decls.module.filter((d) => d.kind !== "list").map((d) => d.name + "=" + pureType(d)).join(", ") + ")");
    out.push("");
  }
  // reconstruct the source, decorating each def
  const byLine = new Map();
  for (const f of decls.functions) byLine.set(defLine(stmts, f.name), f);
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const f = byLine.get(ln);
    if (f && f.locals.length) {
      const ind = /^[ \t]*/.exec(lines[i].text)[0];
      out.push(ind + "@cython.locals(" + f.locals.map((l) => l.name + "=" + pureType(l)).join(", ") + ")");
    }
    out.push(lines[i].text);
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

function defLine(stmts, name) {
  for (const st of stmts) {
    if (st.k === "def" && st.name === name) return st.line;
    if (st.k === "if") for (const b of st.branches) { const r = defLine(b.body, name); if (r) return r; }
    if (st.k === "if" && st.elseBody) { const r = defLine(st.elseBody, name); if (r) return r; }
    if ((st.k === "for" || st.k === "while") && st.body) { const r = defLine(st.body, name); if (r) return r; }
  }
  return 0;
}

function pureType(d) {
  // pure-Python-mode type objects (cython.*)
  if (d.big) return "object";                       // GMP tier is .pyx-only
  if (d.ctype === "int") return "cython.int";
  if (d.ctype === "unsigned int") return "cython.uint";
  if (d.ctype === "long long") return "cython.longlong";
  if (d.ctype === "unsigned long long") return "cython.ulonglong";
  if (d.ctype === "double") return "cython.double";
  if (d.ctype === "float") return "cython.float";
  if (d.ctype === "str") return "unicode";
  return "object";
}

// ─── renderer: traditional .pyx (§5 mode 1) ─────────────────────
// `cdef` declarations — the form the hand-written bench/*_typed.pyx
// goldens use, including the GMP `cdef extern from "gmp.h"` block for
// bigint variables (Stage 1b).
function renderPyx(source, stmts, A, decls, opts) {
  const lines = lexLines(source);
  const out = [];
  out.push("# cython: language_level=3, boundscheck=False, wraparound=False, cdivision=False");
  out.push("#");
  out.push("# Generated by py2cy (auto-typed Cython — traditional .pyx).");
  out.push("# Compare bench/cython/*_typed.pyx in otranspiler-frontends.");
  out.push("#");
  if (decls.gmp) {
    out.push("# bigint proved: " + [...A.bigints].join(", "));
    out.push("#   Cython has no big-int, so py2cy binds GMP (as bignum_typed.pyx does).");
    out.push(gmpBlock());
    out.push("");
  }
  const byLine = new Map();
  for (const f of decls.functions) byLine.set(defLine(stmts, f.name), f);
  // memoryview lists: the buffer import plus the construction rewrites
  // (`arr = [...]` → `arr = array('q', [...])`; the `cdef` comes from the
  // decl's view ctype via moduleDefs below).
  const viewDefs = decls.module.filter((d) => d.kind === "view");
  if (viewDefs.length) {
    out.push("from array import array  # buffer source for the typed memoryview(s) below");
    out.push("");
  }
  const viewLines = new Map();
  if (A.listViews) for (const [name, vw] of A.listViews) viewLines.set(vw.line, vw.text);
  // module-scope declarations live at the top of the .pyx at column 0.
  // (A .pyx has no implicit main: the .pyx `def main():` in the goldens
  // exists because bench/rolling_hash.py is a top-level script; py2cy
  // keeps the script shape and declares its globals directly.)
  const moduleDefs = decls.module.filter((d) => d.kind !== "bigint");
  if (moduleDefs.length) {
    out.push("# module-scope declarations (proved by the flow analysis)");
    for (const d of moduleDefs) out.push("cdef " + d.ctype + " " + d.name);
    out.push("");
  }
  // bigint declarations + the init/clear brackets around the top-level flow.
  // Rewrites (and huge-guard temps) are collected FIRST: a temp bound needs
  // its own cdef/init/clear next to the bigints.
  const bigs = decls.module.filter((d) => d.kind === "bigint").map((d) => d.name)
    .concat(decls.functions.flatMap((f) => f.locals.filter((l) => l.kind === "bigint").map((l) => l.name)));
  const bigRewrites = [];       // { at, end, text, indent, pre?, temp? } — bigint statement rewrites
  const bigTemps = [];         // hidden mpz bound temps (huge guard literals)
  if (bigs.length) collectBigintRewrites(stmts, bigs, A, bigRewrites, 0, bigTemps);
  if (bigs.length) {
    out.push("# bigint declarations (GMP FFI above) — init/clear bracket the flow");
    for (const name of bigs) out.push("cdef mpz_t " + name);
    for (const name of bigTemps) out.push("cdef mpz_t " + name + "  # hidden bound temp for a huge guard literal");
    for (const name of bigs) out.push("mpz_init(" + name + ")");
    for (const name of bigTemps) out.push("mpz_init(" + name + ")");
    out.push("");
  }
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const rw = bigRewrites.find((r) => r.at === ln);
    if (rw) {
      if (rw.pre) out.push(rw.indent + rw.pre.trim());   // e.g. mpz_set_str for a huge bound, before the loop
      out.push(rw.indent + rw.text.trim()); i = rw.end - 1; continue;
    }
    const vw = viewLines.get(ln);
    if (vw) { out.push(vw); continue; }   // `arr = [...]` → `arr = array('q', [...])`
    const f = byLine.get(ln);
    if (f) {
      const ind = /^[ \t]*/.exec(lines[i].text)[0];
      out.push(ind + "def " + f.name + "(" + f.params.join(", ") + "):");
      // params carry no cdef here (Cython infers object params) — the
      // locals/loop counters are the provable declarations.
      const bodyInd = ind + "    ";
      let anyDecl = false;
      for (const l of f.locals) {
        if (l.big) { out.push(bodyInd + "cdef mpz_t " + l.name); anyDecl = true; continue; }
        if (l.kind === "untyped-list") { continue; }             // a list of unknowns is left as a Python object
        if (l.kind === "list") { out.push(bodyInd + "cdef list " + l.name); anyDecl = true; continue; }
        out.push(bodyInd + "cdef " + l.ctype + " " + l.name); anyDecl = true;
      }
      if (anyDecl) out.push("");                                 // breathe before the body
      // emit the def's body lines verbatim, keeping its indentation
      const headerIndent = lines[i].indent;
      let j = i + 1;
      while (j < lines.length) {
        if (!lines[j].blank && lines[j].indent <= headerIndent) break;
        out.push(lines[j].text);
        j++;
      }
      out.push("");
      i = j - 1;
      continue;
    }
    out.push(lines[i].text);
  }
  if (bigs.length) {
    out.push("");
    out.push("# release the bigints (the GMP counterpart of the Python refcount drop)");
    for (const name of bigs) out.push("mpz_clear(" + name + ")");
    for (const name of bigTemps) out.push("mpz_clear(" + name + ")");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

// walk the statement tree (any depth, any indent) collecting bigint
// rewrites — the bignum_mul shapes live inside a `while` body.
function collectBigintRewrites(stmts, bigs, A, out, depth, temps) {
  const indent = "    ".repeat(depth);
  for (const st of stmts) {
    const r = rewriteBigintStmt(st, bigs, A);
    if (r) { r.indent = indent; out.push(r); continue; }        // rewritten — don't recurse into it
    if (st.k === "if" || st.k === "while") {
      // a bigint loop-test / branch guard becomes a GMP comparison; the
      // body is still walked for inner rewrites, and a huge bound's temp
      // is collected for declaration alongside the bigints.
      const g = rewriteBigintGuard(st, bigs);
      if (g) {
        g.indent = indent; out.push(g);
        if (g.temp && temps && !temps.includes(g.temp)) temps.push(g.temp);
      }
    }
    if (st.k === "if") {
      for (const b of st.branches) collectBigintRewrites(b.body, bigs, A, out, depth + 1, temps);
      if (st.elseBody) collectBigintRewrites(st.elseBody, bigs, A, out, depth + 1, temps);
    } else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) {
      collectBigintRewrites(st.body, bigs, A, out, depth + 1, temps);
    } else if (st.k === "def" && Array.isArray(st.body)) {
      collectBigintRewrites(st.body, bigs, A, out, depth + 1, temps);
    }
  }
}

// ─── bigint statement rewriting (§1b) ───────────────────────────
// Cython has no big-int, so a proved bigint variable's flow has to be
// expressed in GMP calls — exactly what bignum_typed.pyx does by hand.
// Only the shapes we can prove are rewritten; anything else is REFUSED
// (recorded in the manifest) rather than guessed at.
//
// Recognised (the bignum_mul shapes, plus bigint-counter init):
//   x = <lit> ** <lit>        → mpz_ui_pow_ui(x, b, e)
//   x = x * <small uint lit>  → mpz_mul_ui(x, x, k)
//   x = x + <small uint lit>  → mpz_add_ui(x, x, k)
//   x = <small uint lit>      → mpz_set_ui(x, k)   (bigint init, e.g. `i = 0`)
//   print(x % <small uint>)   → printf("%lu\n", mpz_fdiv_ui(x, m))
// Loop guards are NOT handled here (a header is not a value) — see
// rewriteBigintGuard below.
function rewriteBigintStmt(st, bigs, A) {
  const isBig = (n) => bigs.includes(n);
  if (st.k === "assign" && st.op === "=" && st.targets.length === 1 && st.targets[0].name && isBig(st.targets[0].name)) {
    const t = st.targets[0].name, v = st.values[0];
    if (!v) return null;
    // x = <lit> ** <lit>
    if (v.t === "bin" && v.op === "**") {
      const b = litOf(v.a), e = litOf(v.b);
      if (b != null && e != null && b >= 0n && e >= 0n && b <= 2n ** 32n && e <= 2n ** 32n) {
        return { at: st.line, end: st.line, text: "mpz_ui_pow_ui(" + t + ", " + b + ", " + e + ");" };
      }
      A.refuse(st.line, "bigint", "bigint power with non-literal / oversized operands — GMP tier not emitted", st.raw.trim());
      return null;
    }
    // x = x <op> <lit>
    if (v.t === "bin" && ["*", "+", "-"].includes(v.op)) {
      const l = v.a, r = v.b;
      const self = l && l.t === "name" && l.v === t;
      const k = litOf(r);
      if (self && k != null && k >= 0n && k <= 2n ** 32n) {
        const fn = { "*": "mpz_mul_ui", "+": "mpz_add_ui", "-": "mpz_sub_ui" }[v.op];
        return { at: st.line, end: st.line, text: fn + "(" + t + ", " + t + ", " + k + ");" };
      }
      A.refuse(st.line, "bigint", "bigint arithmetic not expressible as a GMP *_ui call", st.raw.trim());
      return null;
    }
    // x = <small uint lit>  → mpz_set_ui(x, k)  (a bigint's init, e.g. `i = 0`)
    // any other integer literal (negative, huge) → mpz_set_str(x, b"...", 10)
    if (v.t === "num" || v.t === "unary") {
      const k = litOf(v);
      if (k != null && k >= 0n && k <= 2n ** 32n) {
        return { at: st.line, end: st.line, text: "mpz_set_ui(" + t + ", " + k + ");" };
      }
      if (k != null) {
        return { at: st.line, end: st.line, text: "mpz_set_str(" + t + ', b"' + k.toString() + '", 10);' };
      }
      A.refuse(st.line, "bigint", "bigint init with a non-literal value — GMP tier not emitted", st.raw.trim());
      return null;
    }
    A.refuse(st.line, "bigint", "bigint assignment shape not recognised — left as plain Python", st.raw.trim());
    return null;
  }
  // x OP= <small uint lit> on a bigint target — the += spelling of the
  // x = x <op> <lit> shapes above. Without this, an augmented assign fell
  // through silently and was emitted verbatim against an mpz_t (a file that
  // cannot compile with no manifest entry). Anything inexpressible as a
  // GMP *_ui call is refused instead.
  if (st.k === "assign" && st.op !== "=" && st.targets.length === 1 && st.targets[0].name && isBig(st.targets[0].name)) {
    const t = st.targets[0].name, v = st.values[0];
    const fn = { "+=": "mpz_add_ui", "-=": "mpz_sub_ui", "*=": "mpz_mul_ui" }[st.op];
    const k = v ? litOf(v) : null;
    if (fn && k != null && k >= 0n && k <= 2n ** 32n) {
      return { at: st.line, end: st.line, text: fn + "(" + t + ", " + t + ", " + k + ");" };
    }
    A.refuse(st.line, "bigint", "bigint augmented assignment not expressible as a GMP *_ui call — left as plain Python", st.raw.trim());
    return null;
  }
  if (st.k === "expr" && st.expr && st.expr.t === "call") {
    const c = st.expr;
    if (c.fn === "print" && c.args.length) {
      const m = c.args[0] && c.args[0].e;
      // print(x % <small uint>)
      if (m && m.t === "bin" && m.op === "%" && m.a && m.a.t === "name" && isBig(m.a.v)) {
        const k = litOf(m.b);
        if (k != null && k > 0n && k <= 2n ** 32n) {
          return { at: st.line, end: st.line, text: 'printf("%lu\\n", mpz_fdiv_ui(' + m.a.v + ", " + k + "));" };
        }
      }
      // print(x) for a bigint — no GMP print binding in the golden, refuse
      A.refuse(st.line, "bigint", "printing a bigint needs a GMP output binding — not emitted (REFUSE > GUESS)", st.raw.trim());
      return null;
    }
  }
  return null;
}

function litOf(e) {
  if (!e) return null;
  if (e.t === "num") return numVal(e.raw ?? e.v);
  if (e.t === "unary" && e.op === "-") { const v = litOf(e.a); return v == null ? null : -v; }
  return null;
}

// ─── bigint guard rewriting (the loop-test translations) ──────
// A `while`/`if` that tests a bigint variable must become a GMP comparison —
// a header is not a value, so rewriteBigintStmt above cannot cover it.
// Only comparisons against a literal bound are supported.
//
// Recognised (bound fits `unsigned long` — the common `while i < N` shape):
//   while <big> < <uint lit>    → while mpz_cmp_ui(<big>, k) < 0:
//   (<=, >, >=, ==, != analogously; flipped `K <OP> <big>` normalized)
// Huge bound (beyond 64 bits — e.g. `while i < 10**55`): the bound is
// materialized once into a hidden temp via mpz_set_str, and the header
// becomes `while mpz_cmp(<big>, tmp) < 0:`. The caller emits `pre` before
// the header and declares/inits/clears the temp alongside the bigints.
function rewriteBigintGuard(st, bigs) {
  if ((st.k !== "while" && st.k !== "if") || !st.cond || !st.body) return null;
  const c = st.cond;
  if (!c || c.t !== "cmp") return null;
  const isBig = (n) => bigs.includes(n);
  let vname = null, bound = null, op = c.op;
  if (c.a && c.a.t === "name" && isBig(c.a.v)) { vname = c.a.v; bound = litOf(c.b); }
  else if (c.b && c.b.t === "name" && isBig(c.b.v)) { vname = c.b.v; bound = litOf(c.a); op = flipOp(c.op); }
  if (!vname || bound == null) return null;
  const cmpOp = { "<": "< 0", "<=": "<= 0", ">": "> 0", ">=": ">= 0", "==": "== 0", "!=": "!= 0" }[op];
  if (!cmpOp) return null;
  const ULONG_MAX = 2n ** 64n - 1n;
  if (bound >= 0n && bound <= ULONG_MAX) {
    return { at: st.line, end: st.line, text: st.k + " mpz_cmp_ui(" + vname + ", " + bound + ") " + cmpOp + ":", pre: null, temp: null };
  }
  if (bound < 0n) return null;
  const temp = "__py2cy_bound_" + st.line;
  return {
    at: st.line, end: st.line,
    text: st.k + " mpz_cmp(" + vname + ", " + temp + ") " + cmpOp + ":",
    pre: "mpz_set_str(" + temp + ', b"' + bound.toString() + '", 10);',
    temp,
  };
}

function gmpBlock() {
  return [
    "# ── GMP FFI (auto-emitted for a proved bigint; cf. bignum_typed.pyx) ──",
    "from libc.stdio cimport printf",
    'cdef extern from "gmp.h":',
    "    ctypedef struct __mpz_struct:",
    "        int _mp_alloc",
    "        int _mp_size",
    "        void *_mp_d",
    "    ctypedef __mpz_struct mpz_t[1]",
    "    void mpz_init(mpz_t)",
    "    void mpz_clear(mpz_t)",
    "    void mpz_ui_pow_ui(mpz_t, unsigned long, unsigned long)",
    "    void mpz_mul_ui(mpz_t, const mpz_t, unsigned long)",
    "    void mpz_add_ui(mpz_t, const mpz_t, unsigned long)",
    "    void mpz_sub_ui(mpz_t, const mpz_t, unsigned long)",
    "    void mpz_set_ui(mpz_t, unsigned long)",
    "    int mpz_set_str(mpz_t, const char *, int)",
    "    int mpz_cmp_ui(const mpz_t, unsigned long)",
    "    int mpz_cmp(const mpz_t, const mpz_t)",
    "    unsigned long mpz_fdiv_ui(const mpz_t, unsigned long)",
  ].join("\n");
}

// ─── public surface ─────────────────────────────────────────────
export {
  lexLines,
  tokenize,
  parseExpr,
  parseBlock as parseModule,
  Annotator,
  Refuse,
  analyzeModule,
  buildDecls,
};
