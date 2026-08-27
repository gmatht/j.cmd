// ─── bench/gcc-vs-igpu/c-programs.mjs — handwritten C references + the
//     shared problem definitions for the GCC-vs-iGPU comparison ──
//
// Each problem is defined ONCE here so the two sides of the comparison
// cannot drift apart:
//   • inputValue(problem, i)  — the i-th input (JS; the browser page uses
//     it to build the shader textures / vertex attributes);
//   • checksumAdd(problem, acc, r) — the mod-2^32 checksum accumulator
//     (JS; the page verifies the GPU readback against the C binary);
//   • C_SOURCES[problem]      — the HANDWRITTEN C reference (compiled with
//     gcc -O2 by run.mjs; prints the same checksum);
//   • the tiled shader variants the page compiles (2D tiles so the GPU
//     side can process the same N the C side needs for its 10-60 s run).
//
// The C and the page must agree on the input formula and the checksum —
// that agreement is what makes the comparison meaningful.

// ── the three problems ─────────────────────────────────────────
// collatz: N numbers, value v_i = (i*37+3)%251, result = Collatz step count
// ca1d:    N cells, cell i = (i*7+3)%2, one rule-118 step, result = next cell
// hash:    N records, record i = ((i*53)%256,(i*89)%256,(i*127)%256),
//          result = (a*31+b*17+c*7)%256

export const RULE_118 = [0, 1, 1, 1, 0, 1, 1, 0];

// the i-th input value (0-based global index)
export function inputValue(problem, i) {
  switch (problem) {
    case "collatz": return ((i * 37 + 3) % 251) >>> 0;
    case "ca1d": return ((i * 7 + 3) % 2) >>> 0;
    case "hash": return [((i * 53) % 256) >>> 0, ((i * 89) % 256) >>> 0, ((i * 127) % 256) >>> 0];
  }
  throw new Error("unknown problem " + problem);
}

// accumulate one result into the checksum (mod 2^32)
export function checksumAdd(problem, acc, result) {
  return (acc + result) >>> 0;
}

// ── the handwritten C references (gcc -O2) ─────────────────────
export const C_SOURCES = {
  collatz: `/* handwritten C reference: Collatz step count for N numbers.
   value v_i = (i*37+3)%251; prints the checksum (sum of steps, mod 2^32). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  long long n = atoll(argv[1]);
  unsigned int sum = 0;
  for (long long i = 0; i < n; i++) {
    long long v = (i * 37 + 3) % 251;
    int s = 0;
    while (v > 1) { v = (v % 2 == 0) ? v / 2 : 3 * v + 1; s++; }
    sum += (unsigned int)s;
  }
  printf("%u\\n", sum);
  return 0;
}
`,
  ca1d: `/* handwritten C reference: one 1D cellular-automaton step (rule 118)
   over N cells; cell i = (i*7+3)%2; edges clamp; prints the checksum
   (count of live cells in the next row). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  long long n = atoll(argv[1]);
  unsigned int sum = 0;
  for (long long i = 0; i < n; i++) {
    long long l = (i > 0) ? ((i - 1) * 7 + 3) % 2 : 3 % 2;
    long long m = (i * 7 + 3) % 2;
    long long r = (i < n - 1) ? ((i + 1) * 7 + 3) % 2 : ((n - 1) * 7 + 3) % 2;
    int idx = (int)(l * 4 + m * 2 + r);
    int cell = (idx == 1 || idx == 2 || idx == 3 || idx == 5 || idx == 6) ? 1 : 0;
    sum += (unsigned int)cell;
  }
  printf("%u\\n", sum);
  return 0;
}
`,
  hash: `/* handwritten C reference: per-record hash for N records; record i =
   ((i*53)%256,(i*89)%256,(i*127)%256); prints the checksum (sum of hashes,
   mod 2^32). */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  long long n = atoll(argv[1]);
  unsigned int sum = 0;
  for (long long i = 0; i < n; i++) {
    int a = (int)((i * 53) % 256), b = (int)((i * 89) % 256), c = (int)((i * 127) % 256);
    sum += (unsigned int)((a * 31 + b * 17 + c * 7) % 256);
  }
  printf("%u\\n", sum);
  return 0;
}
`,
};

// ── block-reduction shader variants (the browser page compiles these) ──
// Each shader invocation processes BLOCK items and outputs the PARTIAL
// checksum (sum of results mod 2^32, RGBA-packed). The readback is then
// N/BLOCK values instead of N — that is what keeps the GPU side fast: the
// old per-item transport read back every result (gigabytes of readPixels +
// hundreds of millions of JS ops for the 10-60 s C sizes), which froze the
// browser. The inputs are computed IN-SHADER from the global index (32-bit
// safe modular forms of the same formulas the C uses), so no texture upload
// is needed and N is only bounded by the 32-bit index (N < 2^31).
//
// Layout: the canvas is TW×TH where TW*TH ≥ ceil(N/BLOCK); pixel/vertex
// index p = frag_y*TW + frag_x, global item g = p*BLOCK + k. The guard
// `g < N` (N baked) makes the partial last block contribute 0, so the page
// can sum every readback value.

// collatz: block reduction, written in the NAIVE branchy form (a real `while`
// + `if/else`). The `lowerBranchless` pre-pass (below) automatically rewrites it
// into the branchless parity-select + active-mask form, so the GPU never
// diverges on the data-dependent branches — measured ~2.4-5× faster than the
// hand-written branchy ctz form on SwiftShader, and the divergence-free form
// wins by more on a real iGPU. Each item maps g → v=(g*37+3)%251 (same as the
// C collatz()). `basePixels` offsets the global item index for chunked draws
// (see runCollatz) — pass 0 for a single draw.
export function collatzBlockShader(TW, P, BLOCK, basePixels = 0) {
  const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
  return [
    `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
    `g0=$(( p * ${BLOCK} ))`,
    "sum=0",
    `if [ $p -lt ${P} ]; then`,
    "    for b in " + blist + "; do",
    "        g=$(( g0 + b ))",
    "        gm=$(( g - 251 * (g / 251) ))",
    "        n=$(( (gm * 37 + 3) - 251 * ((gm * 37 + 3) / 251) ))",
    "        steps=0",
    "        while [ $n -gt 1 ]; do",
    "            if [ $(( n % 2 )) -eq 0 ]; then",
    "                n=$(( n / 2 ))",
    "                steps=$(( steps + 1 ))",
    "            else",
    "                n=$(( 3 * n + 1 ))",
    "                steps=$(( steps + 1 ))",
    "            fi",
    "        done",
    "        sum=$(( sum + steps ))",
    "    done",
    "fi",
    "putb $(( sum ))",
  ].join("\n");
}

// ca1d: one rule-118 step per item; cell(i) = (i*7+3)%2 = 1-(i%2) (32-bit
// safe); edges clamp (g==0 → left = cell(0), g==N-1 → right = cell(N-1)).
export function ca1dBlockShader(TW, P, N, BLOCK, rule = RULE_118, basePixels = 0) {
  const set = rule.map((v, i) => (v ? i : null)).filter((v) => v !== null);
  const cond = set.map((i) => `idx == ${i}`).join(" || ");
  const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
  const N1 = N - 1;
  return [
    `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
    `g0=$(( p * ${BLOCK} ))`,
    "sum=0",
    `if [ $p -lt ${P} ]; then`,
    "    for b in " + blist + "; do",
    "        g=$(( g0 + b ))",
    "        gm=$(( g - 2 * (g / 2) ))",
    "        m=$(( 1 - gm ))",
    `        if [ $g -eq 0 ]; then l=$m; else gl=$(( g - 1 )); glm=$(( gl - 2 * (gl / 2) )); l=$(( 1 - glm )); fi`,
    `        if [ $g -eq ${N1} ]; then r=$m; else gr=$(( g + 1 )); grm=$(( gr - 2 * (gr / 2) )); r=$(( 1 - grm )); fi`,
    "        idx=$(( l * 4 + m * 2 + r ))",
    `        cell=$(( (${cond}) ? 1 : 0 ))`,
    "        sum=$(( sum + cell ))",
    "    done",
    "fi",
    "putb $(( sum ))",
  ].join("\n");
}

// hash: the per-record hash computed in a FRAGMENT block shader (same
// problem as the catalog's vertex transport, but the POINTS rasterization
// of the large-N benchmark is too fragile on ANGLE — half-pixel point
// centres left gaps in the readback). The record for global item g is
// computed in-shader: a = (g*53)%256 = ((g%256)*53)%256 (32-bit safe).
export function hashBlockFragmentShader(TW, P, BLOCK, basePixels = 0) {
  const blist = Array.from({ length: BLOCK }, (_, i) => i).join(" ");
  return [
    `p=$(( frag_y * ${TW} + frag_x + ${basePixels} ))`,
    `g0=$(( p * ${BLOCK} ))`,
    "sum=0",
    `if [ $p -lt ${P} ]; then`,
    "    for k in " + blist + "; do",
    "        g=$(( g0 + k ))",
    "        gm=$(( g - 256 * (g / 256) ))",
    "        a=$(( (gm * 53) % 256 ))",
    "        b=$(( (gm * 89) % 256 ))",
    "        c=$(( (gm * 127) % 256 ))",
    "        h=$(( (a * 31 + b * 17 + c * 7) % 256 ))",
    "        sum=$(( sum + h ))",
    "    done",
    "fi",
    "putb $(( sum ))",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// sh→GLSL backend helpers
//
// The sh→GLSL backend (otranspilerl_shir_opt, prebuilt WASM) only supports
// fixed-count `for x in LIST` loops and has NO bit ops (`>>` `<<` `&` `|` `^`
// `~` `ctz`) under WebGL1 / GLSL ES 1.00. These JS pre-passes lower `while`
// and bit ops (that can be expressed without WebGL2) into `for` + arithmetic
// the backend already understands, so callers can write a plain `while` loop
// (e.g. the collatz ctz trick) and still target WebGL1.

// Lower `while`/`until` COND; do BODY; done → `for __wN in 0..M; do if COND;
// then BODY; fi; done`. The `if COND` guard gives the early exit that `while`
// would normally provide; the fixed upper bound M guarantees termination and
// bounds GPU time. `until C` is `while !C`, but the backend can't emit `!` in a
// test, so we flip the comparison operator instead (`-eq`→`-ne`, etc.).
// `break`/`continue` are not supported — write the loop so the condition guard
// does the exiting.
//
// OUTER_MAX is the bound for the first (outermost) while — tuned to 64 (≥ the
// 46 outer iterations the collatz ctz trick needs for seed ≤ 250). Bump it if a
function negateTest(cond) {
  const map = { "-eq": "-ne", "-ne": "-eq", "-gt": "-le", "-lt": "-ge", "-ge": "-lt", "-le": "-gt" };
  return cond.replace(/(-eq|-ne|-gt|-lt|-ge|-le)/g, (m) => map[m]);
}

export function lowerWhileLoops(src) {
  const OUTER_MAX = 64, INNER_MAX = 32;
  let s = "\n" + src + "\n";
  let guard = 0;
  for (let iter = 0; iter < 100; iter++) {
    const m = /\b(while|until)\b/.exec(s);
    if (!m) break;
    const kw = m[1], ws = m.index;
    const doRe = /\bdo\b/g; doRe.lastIndex = ws;
    const dm = doRe.exec(s);
    if (!dm) break;
    const doPos = dm.index + 2;
    const head = s.slice(ws, dm.index);
    const cm = head.match(/\[([^\]]*)\]/);
    const cond = cm ? cm[1].trim() : "";
    let depth = 1, bodyEnd = -1, mt, tokRe = /\b(do|done)\b/g;
    tokRe.lastIndex = doPos;
    while ((mt = tokRe.exec(s))) {
      depth += (mt[1] === "do") ? 1 : -1;
      if (depth === 0) { bodyEnd = mt.index; break; }
    }
    if (bodyEnd < 0) break;
    const body = s.slice(doPos, bodyEnd);
    const cap = guard === 0 ? OUTER_MAX : INNER_MAX;
    const v = "w" + (guard++);
    const list = Array.from({ length: cap }, (_, i) => i).join(" ");
    let c = cond;
    if (kw === "until") c = negateTest(cond);
    const replacement = `for ${v} in ${list}; do if [ ${c} ]; then${body}fi; done`;
    s = s.slice(0, ws) + replacement + s.slice(bodyEnd + 4);
  }
  return s.trim();
}

// Emulate the bit ops GLSL ES 1.00 lacks, for the common cases that map to
// integer arithmetic the backend already supports. Only CONSTANT shift amounts
// and power-of-two-minus-one masks are handled, and the result must stay
// non-negative (the backend can't emit a negative fragment output — `~` always
// goes negative, so it is intentionally NOT emulated here). The backend parses
// the real operators but GLSL ES 1.00 rejects them at compile time, so we must
// rewrite them in JS before transpilation.
//   a >> K  ->  a / 2^K          a << K     ->  a * 2^K
//   a & 1   ->  a % 2            a & (2^K-1) -> a % 2^K
// The rewrite is token-level (so it also works inside nested parens), which
// assumes the operand is a single term — write `(a + b) >> K`, not `a + b >> K`.
// General `&`/`|`/`^`/`~` and *variable* shifts are left untouched and will be
// flagged by the backend — those genuinely need WebGL2 (GLSL ES 3.00).
export function lowerBitOps(src) {
  const pow2 = (k) => (1 << k); // 2^k as a JS integer constant
  return src
    .replace(/>>\s*(\d+)/g, (_, k) => '/ ' + pow2(+k))
    .replace(/<<\s*(\d+)/g, (_, k) => '* ' + pow2(+k))
    .replace(/&\s*(\d+)/g, (m, mask) => {
      const m2 = +mask + 1;
      return ((m2 & (m2 - 1)) === 0) ? '% ' + m2 : m;
    });
}

// lowerBranchless: automatically rewrite the NAIVE branchy form
//   while [ $X -gt 1 ]; do
//       if [ $(( X % 2 )) -eq 0 ]; then X=$(( A )); S=$(( S + 1 ));
//       else X=$(( B )); S=$(( S + 1 )); fi
//   done
// into the branchless form (parity select + active mask) so the GPU never
// diverges on the data-dependent branches:
//   for __w in 0..M; do
//       aN=$(( X > 1 ))
//       eN=$(( X % 2 ))
//       tN=$(( (1 - eN) * A + eN * B ))   // select via a TEMP — the backend
//       X=$(( aN * tN + (1 - aN) * X ))   // can't parse deeply-nested exprs
//       S=$(( aN * (S + 1) + (1 - aN) * S ))
//   done
// Rules: the while condition must be `$X -gt K`; the if condition must be
// `$(( X % 2 )) -eq 0`; both branches must assign the same variables with pure
// arithmetic. M = opts.maxIter (default 128 — the max collatz steps for seed ≤
// 250). Not fully general — it targets the collatz-style loop — but it removes
// the need to hand-write the branchless form.
export function lowerBranchless(src, opts = {}) {
  const maxIter = opts.maxIter ?? 128;
  let s = "\n" + src + "\n";
  let guard = 0;
  for (let iter = 0; iter < 50; iter++) {
    const m = /\b(while|until)\b/.exec(s);
    if (!m) break;
    const kw = m[1], ws = m.index;
    const headRe = new RegExp(`${kw}\\s+\\[\\s*([^\\]]+?)\\s*\\]\\s*;\\s*do`).exec(s.slice(ws));
    if (!headRe) break;
    const cond = headRe[1].trim();
    const doPos = ws + headRe[0].indexOf("do") + 2;
    let depth = 1, bodyEnd = -1, mt, tokRe = /\b(do|done)\b/g;
    tokRe.lastIndex = doPos;
    while ((mt = tokRe.exec(s))) { depth += (mt[1] === "do") ? 1 : -1; if (depth === 0) { bodyEnd = mt.index; break; } }
    if (bodyEnd < 0) break;
    let body = s.slice(doPos, bodyEnd);
    body = selectIfElse(body, opts); // transform if/else inside the body first
    const a = "a" + guard;
    const maskVal = testToValue(cond, kw === "until");
    if (!maskVal) break; // can't convert the while condition -> leave for lowerWhileLoops
    const masked = maskBody(body, a, guard);
    const v = "w" + (guard++);
    const list = Array.from({ length: maxIter }, (_, i) => i).join(" ");
    const replacement = `for ${v} in ${list}; do\n        ${a}=${maskVal}\n${masked}\n    done`;
    s = s.slice(0, ws) + replacement + s.slice(bodyEnd + 4);
  }
  return s.trim();
}

// testToValue: `[ LHS -op RHS ]` (the text between the brackets) → a 0/1
// arithmetic value the backend can emit, e.g. `"$n" -gt 1` → `$(( n > 1 ))`,
// `$(( n % 2 )) -eq 0` → `$(( (n % 2) == 0 ))`. `negate` flips the operator
// (for `until`). Returns null if the condition isn't a simple comparison.
function testToValue(cond, negate = false) {
  const m = /^(.+?)\s+(-gt|-lt|-ge|-le|-eq|-ne)\s+(.+)$/.exec(cond);
  if (!m) return null;
  let [, lhs, op, rhs] = m;
  if (negate) op = { "-gt": "-le", "-lt": "-ge", "-ge": "-lt", "-le": "-gt", "-eq": "-ne", "-ne": "-eq" }[op];
  const arith = { "-gt": ">", "-lt": "<", "-ge": ">=", "-le": "<=", "-eq": "==", "-ne": "!=" }[op];
  const toBare = (x) => {
    x = x.trim().replace(/^"|"$/g, ""); // strip quotes ("$vx" → $vx)
    const am = /^\$\(\( (.*) \)\)$/.exec(x);
    if (am) return `(${am[1]})`;
    if (/^\$\w+$/.test(x)) return x.slice(1);
    return x;
  };
  return `$(( ${toBare(lhs)} ${arith} ${toBare(rhs)} ))`;
}

// selectIfElse: transform every SELECTABLE `if [ COND ]; then ... (else ...)
// fi` into arithmetic selects (parity-style, via temps). Selectable = the
// condition converts to a 0/1 value AND both bodies are pure assignments (no
// nested for/while/if — structural guards like `if [ $p -lt $P ]` are left
// alone). Processes innermost-first so nested ifs (e.g. a clamp inside a
// guard) are handled. Variables assigned in both branches → select; in one
// branch → masked by the condition. The select goes through a temp because the
// backend can't parse deeply-nested expressions.
//
// opts.skipTrivial (default true): skip TRIVIAL branches — a body assignment
// to a CONSTANT literal (e.g. `v=0`, `v=255` — a clamp/saturate). The select
// `e*0 + (1-e)*v` is provably wasteful (the `e*0` is always 0) and the branchy
// form is a single cheap op, so the transformation adds more arithmetic than
// it saves on a scalar renderer. Variable-assignment branches (max=v,
// count+1) are genuine selects and are still transformed.
export function selectIfElse(src, opts = {}) {
  const skipTrivial = opts.skipTrivial !== false;
  let out = "\n" + src + "\n";
  const trivial = new Map(); // placeholder -> original if/else text (restored at the end)
  let k = 0, t = 0;
  for (let i = 0; i < 300; i++) {
    const m = /if\s+\[\s*([^\]]+?)\s*\]\s*;\s*then((?:(?!\bif\b)[\s\S])*?)(?:else((?:(?!\bif\b)[\s\S])*?))?fi/.exec(out);
    if (!m) break;
    const cond = m[1].trim();
    const thenBody = m[2], elseBody = m[3] || "";
    // structural guard: never rewrite an if/else whose body contains a loop or
    // another if (e.g. the outer `if [ $p -lt $P ]` block guard) — only
    // pure-assignment bodies are selectable.
    if (/(for|while|until|if)\b/.test(thenBody) || /(for|while|until|if)\b/.test(elseBody)) break;
    const val = testToValue(cond);
    if (!val) break;
    const assignRe = /(\w+)=\$\(\( ?(.*?) ?\)\)|(\w+)=(\d+|\w+|\$\w+)/g;
    const thenAssigns = [...thenBody.matchAll(assignRe)].map((a) => [a[1] || a[3], (a[2] ?? a[4]).replace(/^\$/, "")]);
    const elseAssigns = [...elseBody.matchAll(assignRe)].map((a) => [a[1] || a[3], (a[2] ?? a[4]).replace(/^\$/, "")]);
    // degenerate-case detection: a body assignment to a constant literal is a
    // trivial clamp/saturate — the select would be `e*const + (1-e)*v` (the
    // `e*0` is always 0), so the transformation adds arithmetic without saving
    // anything. Leave it branchy (restore it at the end).
    if (skipTrivial && [...thenAssigns, ...elseAssigns].some(([, expr]) => /^\d+$/.test(expr))) {
      const ph = `__TRIVIAL_${t++}__`;
      trivial.set(ph, m[0]);
      out = out.replace(m[0], ph);
      continue;
    }
    const thenMap = new Map(thenAssigns);
    const elseMap = new Map(elseAssigns);
    const vars = [...new Set([...thenMap.keys(), ...elseMap.keys()])];
    if (!vars.length) break;
    const e = `e${k}`;
    const lines = [`        ${e}=${val}`];
    // parity special case: `$(( X % 2 )) -eq 0` → e = X % 2 (1 = odd) is much
    // cheaper than the `== 0` comparison, and the then/else weights flip.
    const parity = /^\$\(\( (\w+) % 2 \)\) -eq 0$/.exec(cond);
    let wT = e, wE = `(1 - ${e})`; // general: then = e, else = (1-e)
    if (parity) {
      lines[0] = `        ${e}=$(( ${parity[1]} % 2 ))`;
      wT = `(1 - ${e})`; wE = e; // parity: then (even) = (1-e), else (odd) = e
    }
    let j = 0;
    // else-branch assignments first (masked by wE); shared → select
    for (const [v, el] of elseMap) {
      const t = thenMap.get(v);
      if (t === undefined) {
        const tmp = `t${k}_${j++}`;
        lines.push(`        ${tmp}=$(( ${wE} * (${el}) + ${wT} * ${v} ))`);
        lines.push(`        ${v}=$(( ${tmp} ))`);
      } else if (t === el) {
        lines.push(`        ${v}=$(( ${t} ))`);
      } else {
        const tmp = `t${k}_${j++}`;
        lines.push(`        ${tmp}=$(( ${wT} * (${t}) + ${wE} * (${el}) ))`);
        lines.push(`        ${v}=$(( ${tmp} ))`);
      }
    }
    // then-branch unique variables (masked by wT)
    for (const [v, t] of thenMap) {
      if (elseMap.has(v)) continue;
      const tmp = `t${k}_${j++}`;
      lines.push(`        ${tmp}=$(( ${wT} * (${t}) + ${wE} * ${v} ))`);
      lines.push(`        ${v}=$(( ${tmp} ))`);
    }
    out = out.replace(m[0], lines.join("\n"));
    k++;
  }
  for (const [ph, orig] of trivial) out = out.replace(ph, orig); // restore skipped trivial ifs
  return out.trim();
}

// maskBody: mask every assignment in a while body with the loop's active flag
// (temps eN / tN_M are left unmasked).
function maskBody(body, a, guard) {
  return body.split("\n").map((line) => {
    const am = /^\s*(\w+)=\$\(\( ?(.*?) ?\)\)\s*$/.exec(line);
    if (!am) return line;
    const [, Y, E] = am;
    if (Y === "e" + guard || /^e\d+$/.test(Y) || /^t\d+_\d+$/.test(Y)) return line; // temps
    return `        ${Y}=$(( ${a} * (${E}) + (1 - ${a}) * ${Y} ))`;
  }).join("\n");
}
