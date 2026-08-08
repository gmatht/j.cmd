// ─── lean: strip unused polyfills from transpiled output ────────
//
// The otranspilerl renderers emit a fixed prologue regardless of what
// the script actually needs:
//
//   • the C backend prepends its whole `_sh_*` shell-out runtime
//     (~40 helpers: command building, capture, param expansion, file
//     tests, …) even for a script that is only `printf` + a loop;
//   • the sh backend prepends the `_num()` arithmetic-coercion helper
//     (dash can't coerce non-numeric arith values the way bash does)
//     even when the script never uses arithmetic on a variable.
//
// Everything involved is `static` (internal linkage), so a helper that
// is never called — directly or transitively — is dead weight by
// definition: removing it cannot change behavior.  These functions
// compute that reachability and drop the dead parts:
//
//   leanC(code)  → C source with unused static helpers/vars removed
//   leanSh(code) → sh source with the _num() helper removed when unused
//
// Both are conservative: only `static` definitions are ever touched,
// and only when nothing kept references them.

// ── C scanning helpers (strings, chars, /* */ and // comments aware) ──

// The index just past the `*/` of the block comment that starts at `i`
// (which must point at the `/` of `/*`). C comments do not nest.
function skipBlockComment(s, i) {
  const end = s.indexOf("*/", i + 2);
  return end < 0 ? s.length : end + 2;
}

// The index just past the closing char for the opener at `i`
// (`"`, `'`, `(`, `{`). Depth-counts nested openers of the same kind,
// so `(` matches the right `)` even with inner parens.
function matchC(s, i, open, close) {
  let depth = 0, state = "code";
  for (let p = i; p < s.length; p++) {
    const c = s[p], n = s[p + 1];
    switch (state) {
      case "code":
        if (c === '"') { state = "str"; break; }
        if (c === "'") { state = "chr"; break; }
        if (c === "/" && n === "*") { state = "blk"; p++; break; }
        if (c === "/" && n === "/") { state = "line"; break; }
        if (c === open) depth++;
        else if (c === close && --depth === 0) return p;
        break;
      case "str": if (c === "\\") p++; else if (c === '"') state = "code"; break;
      case "chr": if (c === "\\") p++; else if (c === "'") state = "code"; break;
      case "blk": if (c === "*" && n === "/") { state = "code"; p++; } break;
      case "line": if (c === "\n") state = "code"; break;
    }
  }
  return -1;
}

// The index of the first `;` at/after `from`, skipping literals and
// comments (a declaration statement ends at the FIRST semicolon).
function firstSemicolon(s, from) {
  let state = "code";
  for (let p = from; p < s.length; p++) {
    const c = s[p], n = s[p + 1];
    switch (state) {
      case "code":
        if (c === '"') state = "str";
        else if (c === "'") state = "chr";
        else if (c === "/" && n === "*") state = "blk";
        else if (c === "/" && n === "/") state = "line";
        else if (c === ";") return p;
        break;
      case "str": if (c === "\\") p++; else if (c === '"') state = "code"; break;
      case "chr": if (c === "\\") p++; else if (c === "'") state = "code"; break;
      case "blk": if (c === "*" && n === "/") { state = "code"; p++; } break;
      case "line": if (c === "\n") state = "code"; break;
    }
  }
  return -1;
}

// The identifier immediately before an opening paren at `i`.
function nameBeforeParen(s, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_]/.test(s[k])) k--;
  return s.slice(k + 1, j + 1);
}

// Split the C prologue (text before main) into segments:
//   {kind:"text"}                       — includes, comments, non-static code
//   {kind:"fn",   name, text}           — a static function definition
//   {kind:"var",  name, text}           — one static variable declaration
function splitPrologue(prologue) {
  const segs = [];
  let i = 0, textStart = 0;
  const pushText = (end) => {
    if (end > textStart) segs.push({ kind: "text", text: prologue.slice(textStart, end) });
  };
  while (i < prologue.length) {
    const c = prologue[i];
    if (c === '"' || c === "'") {
      // skip a plain quoted string (backslash-aware). `matchC` can't
      // pair a quote: its "code" state consumes the opening `"` as a
      // string starter, so open==close never matches and it returns -1
      // (which used to bail the WHOLE scan, dropping everything after
      // the first string in a non-static line — e.g. the C const-lift
      // decl `const char name[6] = "world";` and the `_sh_site_N` fn).
      let j = i + 1;
      while (j < prologue.length && prologue[j] !== c) {
        if (prologue[j] === "\\") j++;   // escaped char — skip both
        j++;
      }
      if (j >= prologue.length) return segs; // unterminated — bail
      i = j + 1;
      continue;
    }
    if (c === "/" && prologue[i + 1] === "*") {
      i = skipBlockComment(prologue, i);
      continue;
    }
    if (c === "/" && prologue[i + 1] === "/") {
      const nl = prologue.indexOf("\n", i);
      i = nl < 0 ? prologue.length : nl + 1;
      continue;
    }
    // a `static` keyword at a word boundary?
    if (!/^static\b/.test(prologue.slice(i, i + 6)) ||
        (i > 0 && /[A-Za-z0-9_]/.test(prologue[i - 1]))) {
      i++;
      continue;
    }
    pushText(i);
    // scan to the first of ( ; = (string/comment aware)
    let j = i + 6, state = "code", first = null;
    for (; j < prologue.length; j++) {
      const cc = prologue[j], nn = prologue[j + 1];
      switch (state) {
        case "code":
          if (cc === '"') state = "str";
          else if (cc === "'") state = "chr";
          else if (cc === "/" && nn === "*") state = "blk";
          else if (cc === "/" && nn === "/") state = "line";
          else if (cc === "(" || cc === ";" || cc === "=") { first = { ch: cc, at: j }; j = prologue.length; }
          break;
        case "str": if (cc === "\\") j++; else if (cc === '"') state = "code"; break;
        case "chr": if (cc === "\\") j++; else if (cc === "'") state = "code"; break;
        case "blk": if (cc === "*" && nn === "/") { state = "code"; j++; } break;
        case "line": if (cc === "\n") state = "code"; break;
      }
    }
    if (!first) break;
    if (first.ch === "(") {
      // function definition: name before `(`, body `{ ... }` balanced
      const name = nameBeforeParen(prologue, first.at);
      const closeParen = matchC(prologue, first.at, "(", ")");
      const brace = closeParen >= 0 ? prologue.indexOf("{", closeParen) : -1;
      const end = brace >= 0 ? matchC(prologue, brace, "{", "}") : -1;
      if (end < 0) break;
      segs.push({ kind: "fn", name, text: prologue.slice(i, end + 1) });
      i = end + 1;
    } else {
      // variable declaration: statement ends at the first `;`
      const semi = firstSemicolon(prologue, first.at);
      if (semi < 0) break;
      const piece = prologue.slice(i, semi + 1);
      const m = /static\s+[\w\s\*]*?([A-Za-z_]\w*)\s*(?:=[^;]*)?;/.exec(piece);
      segs.push({ kind: "var", name: m ? m[1] : "", text: piece });
      i = semi + 1;
    }
    textStart = i;
  }
  pushText(prologue.length);
  return segs;
}

// `_sh_<name>(` identifiers in a body of code.
function calledNames(s) {
  const out = new Set();
  const re = /\b(_sh_[A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(s))) out.add(m[1]);
  return out;
}

// Remove unused static helpers from generated C. `code` is the full
// renderer output; `int main` separates the fixed prologue from the
// actual program.
export function leanC(code) {
  const mainIdx = code.indexOf("int main");
  if (mainIdx < 0) return code;              // not our shape — leave alone
  const prologue = code.slice(0, mainIdx);
  const body = code.slice(mainIdx);
  const segs = splitPrologue(prologue);

  // transitive reachability of static functions from main
  const needed = calledNames(body);
  let changed = true;
  while (changed) {
    changed = false;
    for (const seg of segs) {
      if (seg.kind === "fn" && needed.has(seg.name)) {
        for (const c of calledNames(seg.text)) {
          if (!needed.has(c)) { needed.add(c); changed = true; }
        }
      }
    }
  }
  const keptFns = segs.filter((s) => s.kind === "fn" && needed.has(s.name));
  const keptText = keptFns.map((s) => s.text).join("\n");
  // static variables: keep only those referenced by what survives
  const live = body + keptText;
  return segs.map((seg) => {
    if (seg.kind === "text") return seg.text;
    if (seg.kind === "fn") return needed.has(seg.name) ? seg.text + "\n" : "";
    // var
    if (!seg.name) return seg.text;
    const re = new RegExp("\\b" + seg.name + "\\b");
    return re.test(live) ? seg.text + "\n" : "";
  }).join("") + body;
}

// ── sh: drop the _num() arith-coercion helper when the body never
//    calls it (keeps `exec 2>/dev/null` — that one silences stderr
//    from generated command substitution / external commands that
//    don't exist in the target environment). ──
export function leanSh(code) {
  const i = code.indexOf("_num() {");
  if (i < 0) return code;
  const brace = code.indexOf("{", i);
  if (brace < 0) return code;
  const end = matchSh(code, brace);
  if (end < 0) return code;
  const lineStart = code.lastIndexOf("\n", i) + 1;
  const body = code.slice(end + 1);
  if (/\b_num\s*\(/.test(body)) return code;   // used — keep the helper
  return code.slice(0, lineStart) + body;
}

// brace matcher for the _num() body (single-quote aware — the case
// patterns contain '…' quoted strings)
function matchSh(s, i) {
  let depth = 0, inQ = false;
  for (let p = i; p < s.length; p++) {
    const c = s[p];
    if (inQ) { if (c === "'") inQ = false; continue; }
    if (c === "'") { inQ = true; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return p;
  }
  return -1;
}
