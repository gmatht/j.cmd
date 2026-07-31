// ─── perl2js: sh2perl output (Perl) → JavaScript ────────────────
//
// sh2perl (gmatht/debashc, compiled to wasm32-wasip1) transpiles
// bash to Perl. This module transforms that machine-generated Perl
// into JavaScript that runs in the browser shell. Together they form
// the "bash → JS" transpilation pipeline, running entirely in the
// browser:
//
//   bash ──sh2perl.wasm──▶ Perl ──perl2js──▶ JavaScript
//
// The generated JS is statement-level code written against a small
// runtime object `rt` (see buildRuntime() in bash2js.js) and the
// shell's `env` object. It is meant to be wrapped in an async
// function — the shell's JS command runner already does this.
//
// The Perl is machine-generated and very regular:
//   my $x = q{5};            → let x = "5";
//   $y = int($x*2);          → y = Math.trunc(x * 2);
//   print "x=${x}\n";        → rt.print("x=" + x + "\n");
//   if (-f '/etc/passwd')    → if (await rt.test('-f', '/etc/passwd'))
//   for my $f (q{a}, q{b})   → for (let f of ["a", "b"])
//   sub greet { ... }        → function greet() { ... }
//   my $name = do { ... }    → let name = <command substitution>
// -----------------------------------------------------------------

const FTEST_RE = /(?<![\w$])(-([fdrexwLhz]))\s*('(?:[^'\\]|\\.)*'|q\{[^}]*\}|[^\s(),]+)/g;
const REGEX_RE = /(?<![$\w])=~\s*(\/(?:\\.|[^/])*\/)/g;

// ─── placeholder helpers ────────────────────────────────────────
// Placeholders (⟦KEY⟧) isolate constructs we transform out-of-band
// (do{...} blocks, file tests, regex literals) so the expression
// tokenizer never has to guess at their internal structure.

function phToken(key) {
  return "⟦" + key + "⟧";
}

function nextKey(ctx, kind) {
  return kind + (ctx.phCount++);
}

function preprocessExpr(text, ctx) {
  // File tests: (-f '/etc/passwd'), !-d /tmp, -z $x ...
  let out = text.replace(FTEST_RE, (m, op, letter, path) => {
    const key = nextKey(ctx, "FT");
    ctx.ph.set(key, { kind: "ftest", op, path });
    return phToken(key);
  });
  // Regex literals after =~ / !~
  out = out.replace(REGEX_RE, (m, re) => {
    const key = nextKey(ctx, "RE");
    ctx.ph.set(key, { kind: "regex", re });
    return m.replace(re, phToken(key));
  });
  return out;
}

// ─── tokenizer ──────────────────────────────────────────────────

function readBalanced(src, openIdx, open, close) {
  // openIdx points just past the opening delimiter — start with depth 1
  let depth = 1;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return { end: i + 1 };
    }
  }
  throw new Error("unbalanced " + open + close + " in generated Perl: " + JSON.stringify(src) + " @" + openIdx);
}

function tokenizeExpr(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "⟦") {
      const end = src.indexOf("⟧", i);
      toks.push({ t: "PH", key: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === "q" && src[i + 1] === "{") {
      const r = readBalanced(src, i + 2, "{", "}");
      toks.push({ t: "QSTR", v: src.slice(i + 2, r.end - 1) });
      i = r.end;
      continue;
    }
    if (ch === "q" && src[i + 1] === "q" && src[i + 2] === "{") {
      const r = readBalanced(src, i + 3, "{", "}");
      toks.push({ t: "QSTR", v: src.slice(i + 3, r.end - 1) });
      i = r.end;
      continue;
    }
    if (ch === "q" && src[i + 1] === "w" && src[i + 2] === "(") {
      const r = readBalanced(src, i + 3, "(", ")");
      toks.push({ t: "QW", v: src.slice(i + 3, r.end - 1).trim().split(/\s+/) });
      i = r.end;
      continue;
    }
    if (ch === "'") {
      let j = i + 1, buf = "";
      while (j < n) {
        if (src[j] === "\\" && j + 1 < n) { buf += src[j + 1]; j += 2; continue; }
        if (src[j] === "'") break;
        buf += src[j]; j++;
      }
      toks.push({ t: "SSTR", v: buf });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      const parts = [];
      let lit = "";
      const flush = () => { if (lit !== "") { parts.push({ lit }); lit = ""; } };
      while (j < n) {
        const c = src[j];
        if (c === "\\") {
          const e = src[j + 1];
          if (e === "n") { lit += "\n"; j += 2; continue; }
          if (e === "t") { lit += "\t"; j += 2; continue; }
          if (e === "r") { lit += "\r"; j += 2; continue; }
          if (e === '"') { lit += '"'; j += 2; continue; }
          if (e === "\\") { lit += "\\"; j += 2; continue; }
          if (e === "$") { lit += "$"; j += 2; continue; }
          if (e === "{") { lit += "{"; j += 2; continue; }
          if (e === "}") { lit += "}"; j += 2; continue; }
          lit += "\\" + e; j += 2; continue;
        }
        if (c === '"') break;
        if (c === "$") {
          if (src[j + 1] === "{") {
            // ${name} / ${ENV{name}} — find the MATCHING close brace
            const r = readBalanced(src, j + 2, "{", "}");
            const inner = src.slice(j + 2, r.end - 1);
            const envM = /^ENV\{(.+)\}$/.exec(inner);
            flush();
            if (envM) parts.push({ env: envM[1] });
            else parts.push({ var: inner });
            j = r.end;
            continue;
          }
          const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(j + 1));
          if (m) {
            flush();
            if (m[0] === "ENV" && src[j + 4] === "{") {
              const close = src.indexOf("}", j + 5);
              parts.push({ env: src.slice(j + 5, close) });
              j = close + 1;
            } else if (m[0] === "_" && src[j + 2] === "[") {
              const close = src.indexOf("]", j + 2);
              parts.push({ arg: parseInt(src.slice(j + 3, close), 10) || 0 });
              j = close + 1;
            } else {
              parts.push({ var: m[0] });
              j += 1 + m[0].length;
            }
            continue;
          }
          lit += "$"; j++; continue;
        }
        lit += c; j++;
      }
      flush();
      toks.push({ t: "ISTR", parts });
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      if (src[i + 1] === "{") {
        // ${name} / ${ENV{name}} — find the MATCHING close brace
        const r = readBalanced(src, i + 2, "{", "}");
        const inner = src.slice(i + 2, r.end - 1);
        const envM = /^ENV\{(.+)\}$/.exec(inner);
        if (envM) toks.push({ t: "ENVVAR", v: envM[1] });
        else toks.push({ t: "VAR", v: inner });
        i = r.end;
        continue;
      }
      if (src.startsWith("$ENV{", i)) {
        const close = src.indexOf("}", i + 5);
        toks.push({ t: "ENVVAR", v: src.slice(i + 5, close) });
        i = close + 1;
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
      if (m) {
        if (m[0] === "_" && src[i + 1 + m[0].length] === "[") {
          // $_[0] — positional parameter access
          const close = src.indexOf("]", i + 2);
          toks.push({ t: "ARGINDEX", v: parseInt(src.slice(i + 3, close), 10) || 0 });
          i = close + 1;
          continue;
        }
        toks.push({ t: "VAR", v: m[0] });
        i += 1 + m[0].length;
        continue;
      }
      const s = src[i + 1];
      if (s === "?") { toks.push({ t: "TODO", v: "$?" }); i += 2; continue; }
      if (s === "!") { toks.push({ t: "IDENT", v: "errstr" }); i += 2; continue; }
      if (s === "<") { toks.push({ t: "TODO", v: "$<" }); i += 2; continue; }
      toks.push({ t: "TODO", v: "$" + s }); i += 2; continue;
    }
    if (ch === "@" && src[i + 1] === "_") { toks.push({ t: "ATARGS" }); i += 2; continue; }
    if (ch === "@") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
      toks.push({ t: "TODO", v: "@" + (m ? m[0] : "") });
      i += 1 + (m ? m[0].length : 0);
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) { toks.push({ t: "NUM", v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (id) {
      if (id[0] === "undef") { toks.push({ t: "UNDEF" }); i += 4; continue; }
      if (id[0] === "eq") { toks.push({ t: "OP", v: "eq" }); i += 2; continue; }
      if (id[0] === "ne") { toks.push({ t: "OP", v: "ne" }); i += 2; continue; }
      toks.push({ t: "IDENT", v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["=~", "!~", "==", "!=", "<=", ">=", "&&", "||", "//", "..", "++", "--"].includes(two)) {
      toks.push({ t: two === "++" || two === "--" ? "POSTOP" : "OP", v: two });
      i += 2;
      continue;
    }
    if (ch === "=") { toks.push({ t: "ASSIGN" }); i++; continue; }
    if (ch === "(") { toks.push({ t: "LPAREN" }); i++; continue; }
    if (ch === ")") { toks.push({ t: "RPAREN" }); i++; continue; }
    if (ch === "[") { toks.push({ t: "LBRACKET" }); i++; continue; }
    if (ch === "]") { toks.push({ t: "RBRACKET" }); i++; continue; }
    if (ch === ",") { toks.push({ t: "COMMA" }); i++; continue; }
    if (ch === "?") { toks.push({ t: "QMARK" }); i++; continue; }
    if (ch === ":") { toks.push({ t: "COLON" }); i++; continue; }
    if (ch === "!" ) { toks.push({ t: "OP", v: "!" }); i++; continue; }
    if (ch === "/") { toks.push({ t: "OP", v: "/" }); i++; continue; }
    if (["+", "-", "*", "%", "<", ">", "&", "|", "^"].includes(ch)) {
      toks.push({ t: "OP", v: ch });
      i++;
      continue;
    }
    if (ch === ".") { toks.push({ t: "OP", v: "." }); i++; continue; }
    toks.push({ t: "TODO", v: "(char " + ch + ")" });
    i++;
  }
  return toks;
}

// ─── expression parser (small Pratt parser for the Perl subset) ─

const PREC = {
  "||": 2, "//": 2,
  "&&": 3,
  "==": 4, "!=": 4, "eq": 4, "ne": 4,
  "<": 4, ">": 4, "<=": 4, ">=": 4,
  "=~": 4, "!~": 4,
  "+": 5, "-": 5, ".": 5,
  "*": 6, "/": 6, "%": 6,
  "..": 2,
};

function parseExpr(toks, ctx) {
  return parseBinary(toks, ctx, 0);
}

function parseBinary(toks, ctx, minPrec) {
  let left = parseUnary(toks, ctx);
  while (toks.length) {
    const t = toks[0];
    if (t.t === "OP" && PREC[t.v] !== undefined && PREC[t.v] >= minPrec) {
      toks.shift();
      const right = parseBinary(toks, ctx, PREC[t.v] + 1);
      left = { t: "bin", op: t.v, l: left, r: right };
      continue;
    }
    if (t.t === "ASSIGN" && minPrec <= 1) {
      toks.shift();
      const v = parseBinary(toks, ctx, 1);
      left = { t: "assign", target: left, v };
      continue;
    }
    if (t.t === "QMARK" && minPrec <= 1) {
      toks.shift();
      const a = parseBinary(toks, ctx, 1);
      toks.shift(); // ':'
      const b = parseBinary(toks, ctx, 1);
      left = { t: "ternary", c: left, a, b };
      continue;
    }
    // Adjacent primaries ($x$y) — perl concatenates, so do we.
    if (isPrimaryStart(t)) {
      const right = parseUnary(toks, ctx);
      left = { t: "bin", op: ".", l: left, r: right };
      continue;
    }
    break;
  }
  return left;
}

function isPrimaryStart(t) {
  return t && ["VAR", "ENVVAR", "QSTR", "SSTR", "ISTR", "NUM", "LPAREN", "PH", "QW"].includes(t.t);
}

function parseUnary(toks, ctx) {
  const t = toks[0];
  if (!t) return { t: "todo", v: "(missing operand)" };
  if (t.t === "OP" && t.v === "!") { toks.shift(); return { t: "un", op: "!", x: parseUnary(toks, ctx) }; }
  if (t.t === "OP" && t.v === "-") { toks.shift(); return { t: "un", op: "-", x: parseUnary(toks, ctx) }; }
  return parsePostfix(toks, ctx);
}

function parsePostfix(toks, ctx) {
  let node = parsePrimary(toks, ctx);
  while (toks.length) {
    const t = toks[0];
    if (t.t === "LPAREN") {
      toks.shift();
      const args = [];
      if (toks[0] && toks[0].t === "RPAREN") toks.shift();
      else {
        while (toks.length) {
          args.push(parseBinary(toks, ctx, 0));
          if (toks[0] && toks[0].t === "COMMA") { toks.shift(); continue; }
          break;
        }
        toks.shift(); // RPAREN
      }
      node = { t: "call", fn: node, args };
      continue;
    }
    if (t.t === "LBRACKET") {
      toks.shift();
      const idx = parseBinary(toks, ctx, 0);
      toks.shift(); // RBRACKET
      node = { t: "index", x: node, idx };
      continue;
    }
    if (t.t === "POSTOP") {
      toks.shift();
      node = { t: "postfix", op: t.v, x: node };
      continue;
    }
    break;
  }
  return node;
}

function parsePrimary(toks, ctx) {
  const t = toks.shift();
  if (!t) return { t: "todo", v: "eof" };
  switch (t.t) {
    case "VAR": return { t: "var", name: t.v };
    case "ARGINDEX": return { t: "argindex", n: t.v };
    case "ENVVAR": return { t: "env", name: t.v };
    case "QSTR": return { t: "str", v: t.v };
    case "SSTR": return { t: "str", v: t.v };
    case "NUM": return { t: "num", v: t.v };
    case "QW": return { t: "list", items: t.v.map((w) => ({ t: "str", v: w })) };
    case "ISTR": {
      const parts = t.parts;
      if (parts.length === 1) {
        if (parts[0].lit !== undefined) return { t: "str", v: parts[0].lit };
        if (parts[0].var !== undefined) return { t: "var", name: parts[0].var };
        if (parts[0].arg !== undefined) return { t: "argindex", n: parts[0].arg };
        return { t: "env", name: parts[0].env };
      }
      return { t: "istr", parts };
    }
    case "IDENT": return { t: "ident", name: t.v };
    case "UNDEF": return { t: "undef" };
    case "ATARGS": return { t: "todo", v: "@_ outside parameter list" };
    case "PH": {
      const ph = ctx.ph.get(t.key);
      if (!ph) return { t: "todo", v: "missing placeholder " + t.key };
      if (ph.kind === "ftest") return { t: "ftest", op: ph.op, path: ph.path };
      if (ph.kind === "regex") return { t: "regex", v: ph.re };
      if (ph.kind === "do") return { t: "doexpr", code: transformDoBlock(ph.content, ctx).code };
      return { t: "todo", v: "placeholder " + t.key };
    }
    case "LPAREN": {
      const x = parseBinary(toks, ctx, 0);
      if (toks[0] && toks[0].t === "COMMA") {
        const items = [x];
        while (toks[0] && toks[0].t === "COMMA") {
          toks.shift();
          items.push(parseBinary(toks, ctx, 0));
        }
        toks.shift(); // RPAREN
        return { t: "list", items };
      }
      toks.shift(); // RPAREN
      return { t: "paren", x };
    }
    default: return { t: "todo", v: "(token " + t.t + ")" };
  }
}

// ─── codegen ────────────────────────────────────────────────────

function codegen(node, ctx) {
  switch (node.t) {
    case "var": {
      if (node.name === "main_exit_code") return "main_exit_code";
      return ctx.asyncVars.has(node.name) ? "await " + node.name : node.name;
    }
    case "argindex": return `arguments[${node.n}]`;
    case "env": return `env[${JSON.stringify(node.name)}]`;
    case "str": return JSON.stringify(node.v);
    case "num": return node.v;
    case "undef": return "undefined";
    case "ident":
      if (node.name === "errstr") return "rt.errstr()";
      return `rt.todo(${JSON.stringify("identifier " + node.name)})`;
    case "todo": return `rt.todo(${JSON.stringify(node.v)})`;
    case "paren": return `(${codegen(node.x, ctx)})`;
    case "list": return node.items.map((i) => codegen(i, ctx)).join(", ");
    case "bin": {
      const { op, l, r } = node;
      const L = codegen(l, ctx), R = codegen(r, ctx);
      switch (op) {
        case "+": return `rt.add(${L}, ${R})`;
        case ".": return `rt.concat(${L}, ${R})`;
        case "-": case "*": case "/": case "%": return `(${L} ${op} ${R})`;
        case "<": case ">": case "<=": case ">=": return `(Number(${L}) ${op} Number(${R}))`;
        case "==": return `rt.numeq(${L}, ${R})`;
        case "!=": return `!rt.numeq(${L}, ${R})`;
        case "eq": return `rt.streq(${L}, ${R})`;
        case "ne": return `!rt.streq(${L}, ${R})`;
        case "&&": case "||": return `(${L} ${op} ${R})`;
        case "//": return `(${L} ?? ${R})`;
        case "..": return `rt.range(${L}, ${R})`;
        case "=~": return `rt.match(${L}, ${R})`;
        case "!~": return `!rt.match(${L}, ${R})`;
      }
      return `rt.todo(${JSON.stringify("operator " + op)})`;
    }
    case "un": {
      if (node.op === "!") return `!(${codegen(node.x, ctx)})`;
      if (node.op === "-") return `-(${codegen(node.x, ctx)})`;
      return `rt.todo(${JSON.stringify("unary " + node.op)})`;
    }
    case "postfix": return `(${codegen(node.x, ctx)}${node.op})`;
    case "index": return `${codegen(node.x, ctx)}[${codegen(node.idx, ctx)}]`;
    case "assign": return `${codegen(node.target, ctx)} = ${codegen(node.v, ctx)}`;
    case "ternary": return `(${codegen(node.c, ctx)} ? ${codegen(node.a, ctx)} : ${codegen(node.b, ctx)})`;
    case "istr": {
      const items = node.parts.map((p) => {
        if (p.lit !== undefined) return JSON.stringify(p.lit);
        if (p.env !== undefined) return `env[${JSON.stringify(p.env)}]`;
        if (p.arg !== undefined) return `arguments[${p.arg}]`;
        return codegen({ t: "var", name: p.var }, ctx);
      });
      if (items.length === 1) return items[0];
      if (node.parts[0].lit !== undefined) return `(${items.join(" + ")})`;
      return `("" + ${items.join(" + ")})`;
    }
    case "regex": return node.v;
    case "ftest": {
      const pathCode = /^\$/.test(node.path)
        ? codegen(parseExpr(tokenizeExpr(node.path), ctx), ctx)
        : JSON.stringify(unescapePerlStr(node.path));
      return `await rt.test(${JSON.stringify(node.op)}, ${pathCode})`;
    }
    case "doexpr": return node.code;
    case "call": {
      const fn = node.fn;
      const args = node.args.map((a) => codegen(a, ctx));
      if (fn.t === "ident") {
        switch (fn.name) {
          case "int": return `Math.trunc(${args.join(", ")})`;
          case "sleep": case "Time::HiRes::sleep": return `await rt.sleep(${args.join(", ")})`;
          case "system": return `await rt.system(${args.join(", ")})`;
          case "print": return `rt.print(${args.join(", ")})`;
          case "chomp": return `rt.chomp(${args.join(", ")})`;
          case "warn": case "carp": return `rt.warn(${args.join(", ")})`;
          case "errstr": return "rt.errstr()";
          default:
            // A bash function call — we generate `async function name() {`
            return `await ${fn.name}(${args.join(", ")})`;
        }
      }
      return `rt.todo(${JSON.stringify("call " + (fn.t === "ident" ? fn.name : "?"))})`;
    }
    default: return `rt.todo(${JSON.stringify("node " + node.t)})`;
  }
}

// ─── do { ... } blocks (command substitution, pipelines) ────────

// sh2perl emits a pipeline as a do{} block that shells out to
// 'bash', '-c': capture the command and run it through the shell's
// own pipeline machinery via rt.exec. The command literal may be
// single-quoted ('...') or q{...} when the pipeline itself contains
// quotes. Compose the shared "pipeline body" source so the plain
// capture form and the if/while condition wrappers match the same
// shape.
const PIPE_CMD_SRC = String.raw`(?:(?:'(?:\\.|[^'])*')|(?:q\{[^}]*\}))`;
const PIPE_BODY_SRC = String.raw`open\(my \$__fh, (?:'-\|'|q\{-\|\}), 'bash', '-c', (${PIPE_CMD_SRC})\) or (?:die|croak) [^;]*; my \$_r = do \{ local \$\/; <\$__fh> \}; close \$__fh; chomp \$_r; \$CHILD_ERROR = \$\? >> 8; \$_r;`;
const PIPE_DO_SRC = String.raw`do \{ ${PIPE_BODY_SRC} \}`;

// A bare pipeline capture: `my $output_0 = do { <PIPE> };` and friends.
// (transformDoBlock receives the do{} body, i.e. without the braces.)
const PIPE_RE = new RegExp("^\\s*" + PIPE_BODY_SRC + "\\s*$", "s");

// A pipeline as an if/while/until condition. sh2perl wraps the
// pipeline's do{} block in `local $CHILD_ERROR;`, an `# Original
// bash: ...` comment and a trailing `print($output_N, "\n")` — the
// block's *value* is the pipeline's EXIT STATUS, or a boolean of it
// when the generated code ends with `$CHILD_ERROR == 0` /
// `$main_exit_code == 0`. The surrounding `!do {...}` (if), bare
// `do {...}` (if !) and `while/until (do {...})` all turn that into
// the right branch decision: 0 (success) is falsy, non-zero is truthy.
const COND_PIPE_RE = new RegExp(
  "^\\s*" +
  "(?:local \\$CHILD_ERROR;\\s*)?" +
  "(?:# Original bash: [^\\n]*;\\s*)?" +
  "my \\$(\\w+)\\s*=\\s*" + PIPE_DO_SRC + ";\\s*" +
  "print\\(\\$\\1,\\s*\"\\\\n\"\\)\\s*" +
  "(;\\s*(?:\\$CHILD_ERROR|\\$main_exit_code)\\s*==\\s*0\\s*)?" +
  "$",
  "s"
);

// $(cat file) — read a file, strip trailing newlines (bash cmdsub).
const FILE_RE = /^\s*my \$cat_chunk = q\{\};\s*if \( open my \$fh, '<', ('(?:\\.|[^'])*')\s*\) \{ local \$INPUT_RECORD_SEPARATOR = undef; \$cat_chunk = <\$fh>; close \$fh; \} else \{ carp [^}]* \} \$cat_chunk;\s*$/s;

const WHOAMI_RE = /^\s*my \$whoami_user = \(getpwuid\(\$<\)\)\[0\];\s*\$whoami_user \. "\\n";\s*$/;

function unescapePerlStr(q) {
  // q{...} is the single-quoted form Perl uses when the string itself
  // contains quotes (sh2perl emits it for pipelines with ' in them).
  if (q.startsWith("q{") && q.endsWith("}")) return q.slice(2, -1);
  const inner = q.slice(1, -1);
  return inner.replace(/\\(\\|')/g, "$1");
}

function transformDoBlock(content, ctx) {
  // A do{} block's value is its last expression; the common shapes
  // are pipelines, file reads and `whoami` — match those wholesale.
  let m = content.match(PIPE_RE);
  if (m) {
    // Plain pipeline capture (`my $output_0 = do { <PIPE> };`): run it
    // through the shell's own pipeline machinery, record its exit
    // status in CHILD_ERROR, and use the chomped stdout as the value.
    return { code: `await rt.pipe(${JSON.stringify(unescapePerlStr(m[1]))})`, async: true };
  }
  m = content.match(COND_PIPE_RE);
  if (m) {
    // Pipeline as an if/while/until condition: run it, print the
    // captured stdout like bash does for an inherited pipeline, but
    // make the block's VALUE the pipeline's exit status (or a boolean
    // of it) so `if (!do {...})`, `while (do {...})` and
    // `until (do {...})` make the correct branch decision.
    const cmd = unescapePerlStr(m[2]);
    const asBool = m[3] !== undefined;
    return { code: `await rt.pipeCond(${JSON.stringify(cmd)}, ${asBool})`, async: true };
  }
  m = content.match(FILE_RE);
  if (m) {
    // Raw file content; the enclosing `chomp $__cs` strips the trailing
    // newline for $(cat ...), while a bare `cat file` keeps it.
    return { code: `await rt.readFile(${JSON.stringify(unescapePerlStr(m[1]))})`, async: true };
  }
  m = content.match(WHOAMI_RE);
  if (m) {
    return { code: `rt.concat(rt.whoami(), "\\n")`, async: false };
  }

  // General do{} block: replace nested do{}s, then transform the
  // statements; the last expression becomes the block's value.
  let text = preReplaceDoBlocks(content, ctx);
  const chunks = splitStatements(text);
  const lines = transformChunks(chunks, ctx, { lastExpr: true });
  const js = lines.join("\n");
  const isAsync = /\bawait\s/.test(js);
  // Await inline so the do{} expression's value is resolved, not a Promise
  const wrapped = isAsync ? `(await (async () => {\n${js}\n})())` : `(() => {\n${js}\n})()`;
  return { code: wrapped, async: isAsync };
}

// ─── pre-pass: pull do { ... } blocks out of the source ─────────

function preReplaceDoBlocks(src, ctx) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const idx = src.indexOf("do", i);
    if (idx === -1) { out += src.slice(i); break; }
    // Only the keyword `do` (not part of another identifier)
    const before = src[idx - 1];
    if (before !== undefined && /[A-Za-z0-9_]/.test(before)) { out += src.slice(i, idx + 2); i = idx + 2; continue; }
    let j = idx + 2;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === "{") {
      out += src.slice(i, idx);
      const r = readBalanced(src, j + 1, "{", "}");
      const key = nextKey(ctx, "DO");
      ctx.ph.set(key, { kind: "do", content: src.slice(j + 1, r.end - 1) });
      out += phToken(key);
      i = r.end;
    } else {
      out += src.slice(i, idx + 2);
      i = idx + 2;
    }
  }
  return out;
}

// ─── statement splitter ─────────────────────────────────────────
// Splits on ';' at paren-depth 0 and isolates '{' / '}' (block
// boundaries) at paren-depth 0, respecting strings and q{...}.

function splitStatements(src) {
  const chunks = [];
  let cur = "";
  let paren = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'") {
      cur += ch; i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) { cur += src[i] + src[i + 1]; i += 2; continue; }
        cur += src[i];
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      cur += ch; i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) { cur += src[i] + src[i + 1]; i += 2; continue; }
        cur += src[i];
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "q" && (src[i + 1] === "{" || (src[i + 1] === "q" && src[i + 2] === "{"))) {
      let open = i + 1;
      if (src[open] === "q") open++;
      cur += src.slice(i, open + 1);
      i = open + 1;
      let d = 1;
      while (i < n) {
        if (src[i] === "{") d++;
        else if (src[i] === "}") {
          d--;
          cur += src[i]; // keep the closing brace
          i++;
          if (d === 0) break;
          continue;
        }
        cur += src[i]; i++;
      }
      continue;
    }
    if (ch === "$") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
      if (m) {
        cur += "$" + m[0];
        i += 1 + m[0].length;
        if (src[i] === "{") {
          let d = 1; cur += src[i]; i++;
          while (i < n) {
            if (src[i] === "{") d++;
            else if (src[i] === "}") {
              d--;
              cur += src[i]; // keep the closing brace
              i++;
              if (d === 0) break;
              continue;
            }
            cur += src[i]; i++;
          }
        }
        continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === "(") { paren++; cur += ch; i++; continue; }
    if (ch === ")") { paren--; cur += ch; i++; continue; }
    if (ch === "{" && paren === 0) {
      // A perl filehandle block `{$fh}` (print {$fh} ...) is not a
      // control-flow block — keep it inside the current chunk.
      if (/^\{\s*\$\w+\s*\}/.test(src.slice(i))) {
        const close = src.indexOf("}", i);
        cur += src.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      chunks.push(cur); chunks.push("{"); cur = ""; i++; continue;
    }
    if (ch === "}" && paren === 0) { chunks.push(cur); chunks.push("}"); cur = ""; i++; continue; }
    if (ch === ";" && paren === 0) { chunks.push(cur); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  chunks.push(cur);
  return chunks;
}

// ─── statement transform ────────────────────────────────────────

// Strip a Perl `# ...` comment from the end of a statement, keeping
// '#' inside quoted strings (', ", q{...}) intact. sh2perl annotates
// pipeline conditions with `# Original bash: <cmd>;` lines — those
// must never reach the expression parser.
function stripPerlComment(s) {
  let inS = false, inD = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (inS) {
      if (ch === "\\" && i + 1 < n) { i += 2; continue; }
      if (ch === "'") inS = false;
      i++;
      continue;
    }
    if (inD) {
      if (ch === "\\" && i + 1 < n) { i += 2; continue; }
      if (ch === '"') inD = false;
      i++;
      continue;
    }
    if (ch === "'") { inS = true; i++; continue; }
    if (ch === '"') { inD = true; i++; continue; }
    if (ch === "q" && s[i + 1] === "{") {
      let d = 1;
      i += 2;
      while (i < n && d > 0) {
        if (s[i] === "{") d++;
        else if (s[i] === "}") d--;
        i++;
      }
      continue;
    }
    if (ch === "#") return s.slice(0, i);
    i++;
  }
  return s;
}

function expr(text, ctx) {
  const pre = preprocessExpr(text, ctx);
  return codegen(parseExpr(tokenizeExpr(pre), ctx), ctx);
}

function condExpr(text, ctx) {
  return expr(text, ctx);
}

// Parse a comma-separated expression list (perl `print(a, b, c)`).
function exprList(text, ctx) {
  const pre = preprocessExpr(text, ctx);
  const toks = tokenizeExpr(pre);
  const items = [];
  while (toks.length) {
    items.push(parseBinary(toks, ctx, 0));
    if (toks[0] && toks[0].t === "COMMA") { toks.shift(); continue; }
    break;
  }
  return items.map((i) => codegen(i, ctx));
}

function openWriteStmt(fh, mode, pathText, ctx) {
  const path = expr(pathText, ctx);
  return `let ${fh} = ${mode === ">>" ? "await rt.openAppend(" : "await rt.openWrite("}${path});`;
}

function printToFh(fh, argsText, ctx) {
  const items = exprList(argsText, ctx);
  const code = items.length === 1 ? items[0] : items.reduce((a, b) => `rt.concat(${a}, ${b})`);
  return `${fh}.write(${code});`;
}

function transformChunk(chunk, ctx, opts = {}) {
  const s = chunk.trim();
  if (s === "") return null;
  if (s === "{") return "{";
  if (s === "}") return "}";
  if (s === "else") return "else";

  // Drop Perl comments: a chunk that is only a comment vanishes, and
  // a trailing comment is stripped before the statement is matched.
  const stripped = stripPerlComment(s).trim();
  if (stripped === "") return null;
  if (stripped !== s) return transformChunk(stripped, ctx, opts);

  // Dropped constructs
  if (/^(use|require|local)\b/.test(s)) return null;

  let m;

  // Control-flow headers (the '{' arrives as its own chunk)
  if ((m = /^if\s*\((.*)\)$/s.exec(s))) return { line: `if (${condExpr(m[1], ctx)}) {`, brace: true };
  if ((m = /^elsif\s*\((.*)\)$/s.exec(s))) return { line: `else if (${condExpr(m[1], ctx)}) {`, brace: true };
  if ((m = /^while\s*\((.*)\)$/s.exec(s))) return { line: `while (${condExpr(m[1], ctx)}) {`, brace: true };
  if ((m = /^until\s*\((.*)\)$/s.exec(s))) return { line: `while (!(${condExpr(m[1], ctx)})) {`, brace: true };
  if ((m = /^for\s+my\s+\$([A-Za-z_]\w*)\s*\((.*)\)$/s.exec(s))) return { line: forMyHeader(m[1], m[2], ctx), brace: true };
  if ((m = /^for\s*\((.*)\)$/s.exec(s))) return { line: cForHeader(m[1], ctx), brace: true };
  if ((m = /^sub\s+([A-Za-z_]\w*)$/.exec(s))) return { line: `async function ${m[1]}() {`, brace: true };

  // Declarations & assignments
  if ((m = /^my\s+\(([^)]*)\)\s*=\s*@_$/.exec(s))) {
    const names = m[1].split(",").map((x) => x.trim().replace(/^\$/, ""));
    return `let ${names.map((nm, i) => `${nm} = arguments[${i}]`).join(", ")};`;
  }
  if ((m = /^my\s+\$([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(s))) {
    const rhs = expr(m[2], ctx);
    const name = m[1];
    return `let ${name} = ${rhs};`;
  }
  if ((m = /^my\s+\$([A-Za-z_]\w*)$/.exec(s))) return `let ${m[1]};`;
  if ((m = /^our\s+\$([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(s))) return `let ${m[1]} = ${expr(m[2], ctx)};`;
  if ((m = /^\$ENV\{([^}]+)\}\s*=\s*(.+)$/s.exec(s))) return `env[${JSON.stringify(m[1])}] = ${expr(m[2], ctx)};`;
  if ((m = /^\$([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(s)) && !/^\s*=/.test(m[2])) {
    return `${m[1]} = ${expr(m[2], ctx)};`;
  }

  // I/O & flow statements
  if ((m = /^print\s*\((.*)\)$/s.exec(s))) return `rt.print(${exprList(m[1], ctx).join(", ")});`;
  if ((m = /^print\s+\{\$(\w+)\}\s*\((.*)\)$/s.exec(s))) return printToFh(m[1], m[2], ctx);
  if ((m = /^print\s+\{\$(\w+)\}\s+(.+)$/s.exec(s))) return printToFh(m[1], m[2], ctx);
  if ((m = /^print\s+(\$\w+)\s+(.+)$/s.exec(s))) return printToFh(m[1].slice(1), m[2], ctx);
  if ((m = /^print\s+(.+)$/s.exec(s))) return `rt.print(${exprList(m[1], ctx).join(", ")});`;
  if ((m = /^printf\s*\((.*)\)$/s.exec(s))) return `rt.printf(${exprList(m[1], ctx).join(", ")});`;
  if ((m = /^printf\s+(.+)$/s.exec(s))) return `rt.printf(${exprList(m[1], ctx).join(", ")});`;
  if ((m = /^chomp\s+\$([A-Za-z_]\w*)$/.exec(s))) {
    return `${m[1]} = rt.chomp(${ctx.asyncVars.has(m[1]) ? "await " : ""}${m[1]});`;
  }
  if ((m = /^exit\s*(.+)$/s.exec(s))) return `return Number(${expr(m[1], ctx)});`;
  if ((m = /^return\s*(.*)$/s.exec(s))) return m[1].trim() ? `return ${expr(m[1], ctx)};` : "return;";
  // while/until pipelines are implemented with `last unless/if` guards
  // (splitStatements strips the trailing `;`, so bare `last` matches too)
  if ((m = /^last\s+unless\s*\((.*)\)$/s.exec(s))) return `if (!(${condExpr(m[1], ctx)})) break;`;
  if ((m = /^last\s+if\s*\((.*)\)$/s.exec(s))) return `if (${condExpr(m[1], ctx)}) break;`;
  if ((m = /^last\s+unless\s+(.+)$/s.exec(s))) return `if (!(${expr(m[1], ctx)})) break;`;
  if ((m = /^last\s+if\s+(.+)$/s.exec(s))) return `if (${expr(m[1], ctx)}) break;`;
  if (s === "last") return "break;";
  if (s === "next") return "continue;";
  if ((m = /^die\s+(.+)$/s.exec(s))) return `throw new Error(String(${expr(m[1], ctx)}));`;
  if ((m = /^carp\s+(.+)$/s.exec(s))) return `rt.warn(${expr(m[1], ctx)});`;
  if ((m = /^warn\s+(.+)$/s.exec(s))) return `rt.warn(${expr(m[1], ctx)});`;
  if ((m = /^\(?(Time::HiRes::)?sleep\s*\((.*)\)\)?\s*$/.exec(s))) return `await rt.sleep(${expr(m[2], ctx)});`;
  if ((m = /^system\s*\((.*)\)$/s.exec(s))) return `await rt.system(${expr(m[1], ctx)});`;
  if ((m = /^join\s+(.+)$/s.exec(s))) {
    const items = exprList(m[1], ctx);
    const sep = items.shift();
    const code = `rt.join(${sep}, ${items.join(", ")})`;
    return opts.last ? `return ${code};` : `${code};`;
  }

  // File open for writing: open(my $fh, '>', path) or die "...";
  if ((m = /^open\(my \$(\w+),\s*('>>'|'>')\s*,\s*(.+?)\)\s+or\s+die\b/.exec(s))) return openWriteStmt(m[1], m[2], m[3], ctx);
  if ((m = /^open\s+my \$(\w+),\s*('>>'|'>')\s*,\s*(.+?)\s+or\s+die\b/.exec(s))) return openWriteStmt(m[1], m[2], m[3], ctx);
  if ((m = /^close\s+\$(\w+)$/.exec(s))) return `await ${m[1]}.close();`;

  // Bare expression — the last one inside a do{} block is its value
  if (opts.last) return `return ${expr(s, ctx)};`;
  const code = expr(s, ctx);
  return `${code};`;
}

// Transform one chunk, returning a line string. Control headers come
// back as { line, brace: true } so the caller can swallow the
// standalone '{' chunk that follows (the header already emits it).
function emitChunk(chunk, ctx, opts = {}) {
  const result = transformChunk(chunk, ctx, opts);
  if (result && typeof result === "object" && result.brace) {
    return { line: result.line, brace: true };
  }
  return { line: result, brace: false };
}

function transformChunks(chunks, ctx, opts = {}) {
  const lines = [];
  let skipBrace = false;
  const clean = chunks.filter((c) => c.trim() !== "");
  for (let i = 0; i < clean.length; i++) {
    if (skipBrace) {
      skipBrace = false;
      if (clean[i].trim() === "{") continue;
    }
    const last = opts.lastExpr && i === clean.length - 1;
    const { line, brace } = emitChunk(clean[i], ctx, { last });
    if (line) lines.push(line);
    if (brace) skipBrace = true;
  }
  return lines;
}

function forMyHeader(varName, listText, ctx) {
  // for my $f (q{a}, q{b}, q{c})  →  for (let f of ["a", "b", "c"])
  // for my $i (0 .. $n)           →  for (let i = 0; i <= n; i++)
  const pre = preprocessExpr(listText, ctx);
  const toks = tokenizeExpr(pre);
  // Detect a single range expression
  if (toks.some((t) => t.t === "OP" && t.v === "..")) {
    const node = parseExpr(toks, ctx);
    if (node.t === "bin" && node.op === "..") {
      const start = codegen(node.l, ctx);
      const end = codegen(node.r, ctx);
      return `for (let ${varName} = ${start}; ${varName} <= ${end}; ${varName}++) {`;
    }
  }
  // A top-level comma-separated list (no wrapping parens in the token stream)
  const items = [];
  while (toks.length) {
    items.push(parseBinary(toks, ctx, 0));
    if (toks[0] && toks[0].t === "COMMA") { toks.shift(); continue; }
    break;
  }
  // A single do{} block (e.g. `for i in $(seq 1 3)`) yields words,
  // split on whitespace like bash command substitution
  if (items.length === 1 && items[0].t === "doexpr") {
    return `for (let ${varName} of rt.split(${items[0].code})) {`;
  }
  return `for (let ${varName} of [${items.map((i) => codegen(i, ctx)).join(", ")}]) {`;
}

function cForHeader(initText, ctx) {
  // for (int($ENV{i}=0); int($ENV{i}<3); int($ENV{i}++))
  const parts = initText.split(/;\s*(?![^()]*\))/);
  const [init, cond, step] = [parts[0] || "", parts[1] || "", parts[2] || ""];
  return `for (${expr(init, ctx)}; ${condExpr(cond, ctx)}; ${expr(step, ctx)}) {`;
}

// ─── main entry ─────────────────────────────────────────────────

export function perlToJS(perl, opts = {}) {
  const ctx = {
    ph: new Map(),
    phCount: 0,
    asyncVars: new Set(),
  };
  // Drop the shebang line so the leading `use strict;` is a clean chunk
  const cleaned = perl.replace(/^#![^\n]*\n?/, "");
  const src = preReplaceDoBlocks(cleaned, ctx);
  const chunks = splitStatements(src);
  const lines = transformChunks(chunks, ctx);
  return lines.join("\n") + "\n";
}
