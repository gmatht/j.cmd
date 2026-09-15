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
  const n = need == null ? 0n : need;
  if (lo == null || hi == null) return n >= LIM_I64 ? "long long" : "long long";   // unbounded value → widest C int
  const fitsI32 = lo >= -LIM_I32 && hi < LIM_I32 && n < LIM_I32;
  const fitsU32 = lo >= 0n && hi < LIM_U32 && n < LIM_U32;
  if (fitsI32) return "int";
  if (fitsU32) return "unsigned int";
  return "long long";
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
        // an integer literal beyond i64 is a bigint (GMP tier)
        const v = numVal(e.raw ?? e.v);
        if (v == null) return ANY;                 // float
        if (v > I64_MAX || v < I64_MIN) return BIG;
        return intTy(v, v, absBig(v));
      }
      case "str": return STR;
      case "bool": return intTy(0n, 1n, 1n);
      case "none": return ANY;
      case "name": return env.get(e.v) || ANY;
      case "list": {
        let ok = true, lo = null, hi = null, need = 0n;
        for (const it of e.items) {
          const t = this.typeOf(it, env);
          if (!isIntType(t)) { ok = false; break; }
          lo = minBound(lo, t.lo); hi = maxBound(hi, t.hi);
          need = maxBig([need, t.need ?? 0n]);
        }
        return ok ? { kind: "intlist", lo, hi, need } : LIST;
      }
      case "unary": {
        const a = this.typeOf(e.a, env);
        if (e.op === "not") return intTy(0n, 1n, 1n);
        if (e.op === "~") return isIntType(a) ? intTy(null, null, a.need ?? 0n) : ANY;
        if (e.op === "-") { if (isBigType(a)) return BIG; return isIntType(a) ? intTy(a.hi == null ? null : -a.hi, a.lo == null ? null : -a.lo, a.need ?? 0n) : ANY; }
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
    // an i64-exceeding magnitude is the GMP tier's job, not a wrapping
    // `long long` (AUTO_CYTHON §6, the first hazard in the table).
    const overI64 = (n) => n != null && n > I64_MAX;
    const unbounded = overI64(needAB) ? BIG : intTy(null, null, needAB);
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
        if (!A || !B || B[0] === 0n || B[1] === 0n) return unbounded;
        if (B[0] < 0n) return unbounded;                 // sign-crossing divisor — refuse a proof
        return promote(A[0] / B[0], A[1] / B[1], maxBig([needAB, magnitude([A[0], A[1]])]));
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
      case "int": return e.args[0] ? this.typeOf(e.args[0].e, env) : intTy(0n, null, 0n);
      case "sum": case "min": case "max": {
        // a reduction over a proved int list/range yields an int; the
        // range is not provable without bounds, so it stays unbounded.
        return intTy(null, null, maxBig(e.args.map((a) => (a.e ? this.typeOf(a.e, env).need ?? 0n : 0n))));
      }
      case "abs": {
        const t = e.args[0] ? this.typeOf(e.args[0].e, env) : ANY;
        return isIntType(t) ? intTy(t.lo == null || t.hi == null ? null : minBig([absBig(t.lo), absBig(t.hi)]), t.lo == null || t.hi == null ? null : maxBig([absBig(t.lo), absBig(t.hi)])) : ANY;
      }
      case "print": return ANY;
      case "str": case "repr": return STR;
      case "float": return ANY;
      default: return ANY;
    }
  }
}

function bounded(lo, hi, need) { return intTy(lo, hi, need); }
// a proved Int result, promoted to the bigint tier if it exceeds i64
function promote(lo, hi, need) {
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
function joinTy(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (isBigType(a) || isBigType(b)) return BIG;
  if (a.kind === b.kind) {
    if (a.kind === "int") return intTy(minBound(a.lo, b.lo), maxBound(a.hi, b.hi), maxBig([a.need ?? 0n, b.need ?? 0n]));
    if (a.kind === "intlist") return { kind: "intlist", lo: minBound(a.lo, b.lo), hi: maxBound(a.hi, b.hi), need: maxBig([a.need ?? 0n, b.need ?? 0n]) };
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
            // augmented assign: prove it (widening the live type), but a
            // `+=` is a use+assign — the name must already be declared
            for (let k = 0; k < st.targets.length; k++) {
              const t = st.targets[k];
              const v = st.values[Math.min(k, st.values.length - 1)];
              if (t.name && v) put(t.name, joinTy(env.get(t.name), A.typeOf(v, env)));
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
              for (let k = 0n; k < trip; k++) {
                put(st.target, intTy(bounds.lo + k, bounds.lo + k, bounds.need));
                walk(st.body, env, scope, false);
              }
              A.exact = saved;
            } else {
              put(st.target, intTy(bounds.lo, bounds.hi, bounds.need));
              const saved = A.exact;
              A.exact = false;               // the fixpoint needs the blanket %
              walkLoopBody(st.body, env, scope, walk);
              A.exact = saved;
            }
            put(st.target, intTy(bounds.lo, bounds.hi, bounds.need));
            // only a PROVED i64-exceeding bound is a bigint (GMP) case; an
            // unknown bound is simply unproven — the target stays a Python
            // object (correct, no win) and no GMP FFI is emitted.
            if (bounds.hi != null && (bounds.hi > I64_MAX || bounds.lo < I64_MIN)) A.bigints.add(st.target);
            scope.locals.add(st.target);
            scope.loops.push({ name: st.target, lo: bounds.lo, hi: bounds.hi, need: bounds.need, line: st.line });
          } else {
            const t = A.typeOf(it, env);
            if (t.kind === "intlist" || t.kind === "list") put(st.target, intTy(t.lo, t.hi));
            else {
              put(st.target, ANY);
              A.refuse(st.line, "for", "loop iterator is not a provably-int range (element type unproven)", st.raw.trim());
            }
            const saved = A.exact;
            A.exact = false;
            walkLoopBody(st.body, env, scope, walk);
            A.exact = saved;
          }
          break;
        }
        case "while": {
          const saved = A.exact;
          A.exact = false;
          walkLoopBody(st.body, env, scope, walk);
          A.exact = saved;
          break;
        }
        case "if":
          for (const b of st.branches) walk(b.body, env, scope, widen);
          if (st.elseBody) walk(st.elseBody, env, scope, widen);
          break;
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
  return A;
}

// A loop body is analysed to a FIXPOINT (monotone widening): a
// loop-carried variable is typed from its own previous iteration, so one
// pass is not enough. `h = (h*31 + i) % M` needs the second pass to see
// that `h` is in [0, M-1] on entry to `h*31` — which is what forces the
// 64-bit width. Widening is monotone (joinTy only grows ranges/need), so
// the fixpoint terminates; the cap is belt-and-braces.
function walkLoopBody(body, env, scope, walkFn) {
  const before = () => JSON.stringify([...env].map(([k, v]) => [k, v.lo, v.hi, v.need].map((x) => (typeof x === "bigint" ? x.toString() : x))));
  let prev = before();
  for (let round = 0; round < 8; round++) {
    walkFn(body, env, scope, /*widen*/ round > 0);
    const now = before();
    if (now === prev) break;
    prev = now;
  }
}

// a literal (or literal-derived) value outside i64 → the GMP tier (§1b)
function isBigLiteral(expr) {
  if (!expr) return false;
  switch (expr.t) {
    case "num": { const v = numVal(expr.raw ?? expr.v); return v != null && (v > I64_MAX || v < I64_MIN); }
    case "bin":
      if (expr.op === "**") {
        const b = expr.a, e = expr.b;
        const bv = b && b.t === "num" ? numVal(b.raw ?? b.v) : null;
        const ev = e && e.t === "num" ? numVal(e.raw ?? e.v) : null;
        if (bv != null && ev != null && ev >= 0n && ev < 4096n) {
          const v = bv ** ev;
          return v > I64_MAX || v < I64_MIN;
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
  if (t.kind === "intlist") return { name, ty: "SeqInt[" + (t.lo ?? "?") + "," + (t.hi ?? "?") + "]", ctype: "list", kind: "list", why: why || ("proved an int list; elements ∈ [" + (t.lo ?? "?") + "," + (t.hi ?? "?") + "]") };
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
  const why = !t || t.kind === "any"
    ? "type not provable"
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
  // bigint declarations + the init/clear brackets around the top-level flow
  const bigs = decls.module.filter((d) => d.kind === "bigint").map((d) => d.name)
    .concat(decls.functions.flatMap((f) => f.locals.filter((l) => l.kind === "bigint").map((l) => l.name)));
  if (bigs.length) {
    out.push("# bigint declarations (GMP FFI above) — init/clear bracket the flow");
    for (const name of bigs) out.push("cdef mpz_t " + name);
    for (const name of bigs) out.push("mpz_init(" + name + ")");
    out.push("");
  }
  const bigRewrites = [];       // { at, end, text, indent } — bigint statement rewrites
  if (bigs.length) collectBigintRewrites(stmts, bigs, A, bigRewrites, 0);
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const rw = bigRewrites.find((r) => r.at === ln);
    if (rw) { out.push(rw.indent + rw.text.trim()); i = rw.end - 1; continue; }
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
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

// walk the statement tree (any depth, any indent) collecting bigint
// rewrites — the bignum_mul shapes live inside a `while` body.
function collectBigintRewrites(stmts, bigs, A, out, depth) {
  const indent = "    ".repeat(depth);
  for (const st of stmts) {
    const r = rewriteBigintStmt(st, bigs, A);
    if (r) { r.indent = indent; out.push(r); continue; }        // rewritten — don't recurse into it
    if (st.k === "if") {
      for (const b of st.branches) collectBigintRewrites(b.body, bigs, A, out, depth + 1);
      if (st.elseBody) collectBigintRewrites(st.elseBody, bigs, A, out, depth + 1);
    } else if ((st.k === "for" || st.k === "while") && Array.isArray(st.body)) {
      collectBigintRewrites(st.body, bigs, A, out, depth + 1);
    } else if (st.k === "def" && Array.isArray(st.body)) {
      collectBigintRewrites(st.body, bigs, A, out, depth + 1);
    }
  }
}

// ─── bigint statement rewriting (§1b) ───────────────────────────
// Cython has no big-int, so a proved bigint variable's flow has to be
// expressed in GMP calls — exactly what bignum_typed.pyx does by hand.
// Only the shapes we can prove are rewritten; anything else is REFUSED
// (recorded in the manifest) rather than guessed at.
//
// Recognised (the bignum_mul shapes):
//   x = <lit> ** <lit>        → mpz_ui_pow_ui(x, b, e)
//   x = x * <small uint lit>  → mpz_mul_ui(x, x, k)
//   x = x + <small uint lit>  → mpz_add_ui(x, x, k)
//   print(x % <small uint>)   → printf("%lu\n", mpz_fdiv_ui(x, m))
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
    A.refuse(st.line, "bigint", "bigint assignment shape not recognised — left as plain Python", st.raw.trim());
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
