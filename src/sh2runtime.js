// ─── sh2runtime: the `sh2.*` namespace debashl's ESTree targets ─
//
// debashl lowers shell semantics to calls into this documented runtime
// (PLAN.md §1.2): sh2.fs-style stat via statSync, sh2.exec, sh2.pipeline,
// sh2.capture, sh2.redirect, sh2.test, sh2.getVar/setVar, loops, case,
// brace expansion, parameter expansion and arithmetic. The shell creates
// one runtime per bash run and injects it as `sh2` into the generated
// JS; exec() routes through the shell's own command machinery, so bash
// commands see the same builtins, PATH and VFS as typed commands.
// -----------------------------------------------------------------

// Quote a word for a command line (the shell's tokenizer round-trips it).
function quoteWord(w) {
  const s = String(w);
  if (s === "") return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// Glob pattern (case pattern) → RegExp source.
function globToRegExp(pattern) {
  let out = "";
  for (const ch of String(pattern)) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}

export function createSh2Runtime({ fs, env, shellExec, stdout, stderr, args = [], argv0 = "bash" }) {
  const vars = new Map();      // script-local variables (not exported)
  const fns = new Map();       // function definitions
  let scriptArgs = [...args];
  let lastStatus = 0;
  let mode = { type: "plain" };  // plain | capture | pipe | redirect

  // Expand a test-expression operand ($var, ${var}, quotes already stripped).
  // Factory-local: it needs getVar for variable expansion.
  function expandOperand(s) {
    // ${#arr[@]} — array length · ${#name} — string length (the emitter
    // passes both inside test strings like `[ $i -lt ${#arr[@]} ]`)
    const withLen = String(s)
      .replace(/\$\{#([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g, (m, name) => arrayLen(name))
      .replace(/\$\{#([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => String(getVar(name)).length);
    return withLen.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|\d+|#|@|\*|\?|\$|\!)\}?/g, (m, name) => {
      const v = getVar(name);
      return Array.isArray(v) ? v.join(" ") : String(v);
    });
  }

  function getVar(name) {
    const sName = String(name);
    const b = sName.lastIndexOf("[");
    if (b > 0 && sName.endsWith("]")) {
      const arrName = sName.slice(0, b);
      const idx = Number(expandOperand(sName.slice(b + 1, -1)));
      const v = vars.get(arrName);
      if (Array.isArray(v) && Number.isFinite(idx)) return String(v[idx] ?? "");
      return "";
    }
    if (name === "#") return String(scriptArgs.length);
    if (name.startsWith("#") && name.length > 1) return String(String(getVar(name.slice(1))).length);
    if (name === "@") {
      // Space-joined when coerced to a string (quoted "$@"), spread when
      // flattened by exec (word-splitting).
      const arr = [...scriptArgs];
      arr.toString = () => arr.join(" ");
      return arr;
    }
    if (name === "*") return scriptArgs.join(" ");
    if (name === "?") return String(lastStatus);
    if (name === "$") return String((typeof process !== "undefined" && process.pid) || 1);
    if (name === "!") return String(0);
    if (name === "0") return argv0;
    if (/^[1-9]$/.test(name)) return scriptArgs[Number(name) - 1] || "";
    if (vars.has(name)) {
      const v = vars.get(name);
      return Array.isArray(v) ? String(v[0] ?? "") : v;
    }
    if (env && env[name] !== undefined) return String(env[name]);
    return "";
  }

  function setVar(name, value) {
    const s = String(name);
    const val = value === undefined || value === null ? "" : String(value);
    // "arr[$i]" — array element assignment (the compiler passes the
    // index unexpanded)
    const b = s.lastIndexOf("[");
    if (b > 0 && s.endsWith("]")) {
      const arrName = s.slice(0, b);
      const idx = Number(expandOperand(s.slice(b + 1, -1)));
      const existing = vars.get(arrName);
      if (Array.isArray(existing) && Number.isFinite(idx)) {
        const list = existing.slice();
        list[idx] = val;
        vars.set(arrName, list);
        return;
      }
      // not an array (or bad index) — fall through to a plain variable
    }
    vars.set(name, val);
  }

  async function exec(name, argsArr) {
    // User-defined function shadows commands, like in bash.
    if (fns.has(name)) {
      const prevArgs = scriptArgs;
      scriptArgs = (argsArr || []).map(String);
      try {
        const ret = await fns.get(name)();
        // `return N` sets the function's exit status (the transpiler
        // emits the literal as a string). A boolean/void result means
        // the body's commands already recorded $? via exec — leave it.
        if (typeof ret === "string" || typeof ret === "number") {
          lastStatus = Number(ret);
        }
      } finally {
        scriptArgs = prevArgs;
      }
      return lastStatus === 0;
    }
    const cmdline = quoteWord(name) + (argsArr && argsArr.length
      ? " " + flattenArgs(argsArr).map(quoteWord).join(" ")
      : "");
    const res = await shellExec(cmdline, mode.type === "pipe" ? mode.buf.stdin : "");
    lastStatus = res.code;
    if (mode.type === "capture" || mode.type === "pipe") mode.buf.out += res.out;
    else if (mode.type === "redirect") mode.buf.out += res.out;
    else if (res.out) stdout.write(res.out);
    if (res.err) {
      if (mode.type === "redirect") mode.buf.err += res.err;
      else stderr.write(res.err);
    }
    return res.code === 0;
  }

  function flattenArgs(list) {
    const out = [];
    for (const a of list) {
      if (Array.isArray(a)) out.push(...a.map(String));
      else out.push(a === undefined || a === null ? "" : String(a));
    }
    return out;
  }

  async function pipeline(fns) {
    const prev = mode;
    const buf = { out: "", stdin: "" };
    mode = { type: "pipe", buf };
    try {
      for (const fn of fns) {
        buf.stdin = buf.out;  // previous stage's output becomes this stdin
        buf.out = "";
        await fn();
      }
    } finally {
      mode = prev;
    }
    const finalOut = buf.out;
    if (prev.type === "capture" || prev.type === "pipe") prev.buf.out += finalOut;
    else if (prev.type === "redirect") prev.buf.out += finalOut;
    else if (finalOut) stdout.write(finalOut);
    return finalOut;
  }

  async function capture(fn) {
    const prev = mode;
    const buf = { out: "" };
    mode = { type: "capture", buf };
    try {
      await fn();
    } finally {
      mode = prev;
    }
    return buf.out.replace(/\n+$/, "");  // command substitution strips trailing newlines
  }

  async function captureWords(fn) {
    const s = await capture(fn);
    const t = s.trim();
    return t ? t.split(/\s+/) : [];
  }

  async function redirect(fn, redirects) {
    const prev = mode;
    const buf = { out: "", err: "" };
    mode = { type: "redirect", buf };
    try {
      await fn();
    } finally {
      mode = prev;
    }
    const handled = { 1: false, 2: false };
    for (const r of redirects) {
      const fd = r.fd || 1;
      const content = fd === 2 ? buf.err : buf.out;
      handled[fd] = true;
      if (r.mode === "a") {
        let existing = "";
        try { existing = await fs.read(r.target); } catch { /* new file */ }
        await fs.write(r.target, existing + content);
      } else {
        await fs.write(r.target, content);
      }
    }
    // fds that weren't redirected still go to their normal sink
    if (!handled[1] && buf.out) stdout.write(buf.out);
    if (!handled[2] && buf.err) stderr.write(buf.err);
    return true;
  }

  // ─── test: evaluate a `[ ... ]` condition string ─────────────
  // The whole bracket condition arrives as one string: `"$a" = "b"`,
  // `$x -le 3`, `-f /etc/passwd`, `! -z "$x"`, `-f a -a -d b`, ...
  // debashl calls this without await, so it must be synchronous —
  // file tests use statSync (local mounts only).
  function test(expr) {
    try {
      return parseTest(tokenizeTest(expr));
    } catch {
      return false;
    }
  }

  // Tokenize a `[ ... ]` test expression. The emitter DROPS the spaces
  // around operators (`[ $a == x ]` arrives as `$a==x`), so `=`, `==`,
  // `!=`, `<`, `>` and `=~` split even when glued to word characters —
  // the same rule the reference sh2 (sh2perl's harness) uses. Quoted
  // parts expand $vars; `(` / `)` are grouping at word start.
  const TEST_OP_START = (c) => c === "=" || c === "<" || c === ">";
  function tokenizeTest(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (TEST_OP_START(c)) {
        let op = c;
        i++;
        if (c === "=" && (s[i] === "=" || s[i] === "~")) { op += s[i]; i++; }
        tokens.push(op);
        continue;
      }
      if (c === "!") {
        if (s[i + 1] === "=") { tokens.push("!="); i += 2; }
        else { tokens.push("!"); i++; }
        continue;
      }
      if (c === "(" || c === ")") { tokens.push(c); i++; continue; }
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1, out = "";
        while (j < s.length && s[j] !== q) {
          if (s[j] === "\\" && q === '"' && j + 1 < s.length) { out += s[j + 1]; j += 2; continue; }
          out += s[j++];
        }
        tokens.push(expandOperand(out));
        i = j + 1;
        continue;
      }
      let j = i;
      while (j < s.length) {
        const ch = s[j];
        if (ch === " " || ch === "\t" || ch === '"' || ch === "'") break;
        if (TEST_OP_START(ch)) break;
        if (ch === "!" && s[j + 1] === "=") break;
        j++;
      }
      tokens.push(expandOperand(s.slice(i, j)));
      i = j;
    }
    return tokens;
  }

  const BIN_OPS = new Set(["=", "==", "!=", "=~", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot"]);
  const UNARY_OPS = new Set(["-z", "-n", "-f", "-d", "-e", "-x", "-w", "-r", "-s"]);

  function applyBin(op, a, b) {
    if (op === "=" || op === "==") return String(a) === String(b);
    if (op === "!=") return String(a) !== String(b);
    if (op === "=~") { try { return new RegExp(String(b)).test(String(a)); } catch { return false; } }
    if (op === "-nt" || op === "-ot") return false;  // no mtime comparison — keep simple
    const na = Number(a), nb = Number(b);
    if (op === "<") return na < nb;
    if (op === ">") return na > nb;
    if (op === "-eq") return na === nb;
    if (op === "-ne") return na !== nb;
    if (op === "-lt") return na < nb;
    if (op === "-le") return na <= nb;
    if (op === "-gt") return na > nb;
    if (op === "-ge") return na >= nb;
    return false;
  }

  function applyUnary(op, v) {
    if (op === "-z") return String(v).length === 0;
    if (op === "-n") return String(v).length > 0;
    // File tests — statSync is available for local mounts; remote paths
    // report false (can't stat synchronously).
    let st = null;
    try { st = fs.statSync ? fs.statSync(v) : null; } catch { st = null; }
    if (op === "-e") return !!st;
    if (op === "-f") return !!st && st.type === "file";
    if (op === "-d") return !!st && st.type === "dir";
    if (op === "-x" || op === "-w" || op === "-r") return !!st;  // no perms in the VFS
    if (op === "-s") return !!st && (st.size || 0) > 0;
    return false;
  }

  function parseTest(tokens) {
    let pos = 0;
    function primary() {
      const t = tokens[pos];
      if (t === undefined) return false;
      if (t === "!") { pos++; return !primary(); }
      if (t === "(") { pos++; const v = andExpr(); if (tokens[pos] === ")") pos++; return v; }
      if (BIN_OPS.has(tokens[pos + 1])) {
        const a = tokens[pos];
        const op = tokens[pos + 1];
        const b = tokens[pos + 2];
        pos += 3;
        return applyBin(op, a, b);
      }
      if (UNARY_OPS.has(t)) { pos++; return applyUnary(t, tokens[pos] || ""); }
      pos++;
      return String(t).length > 0;  // bare word → non-empty
    }
    function andExpr() {
      let v = primary();
      while (tokens[pos] === "-a") { pos++; v = v && primary(); }
      return v;
    }
    function orExpr() {
      let v = andExpr();
      while (tokens[pos] === "-o") { pos++; v = v || andExpr(); }
      return v;
    }
    return orExpr();
  }

  // Cooperative yielding: the generated JS is otherwise synchronous
  // (a 100k while-loop would freeze the main thread). Every ~50ms of
  // compute we let the event loop breathe — the spinner keeps spinning
  // and clicks stay responsive. exec/capture/pipeline already await, so
  // command-heavy loops yield naturally; this covers the pure-math ones.
  let yieldClock = 0;
  async function maybeYield() {
    if (Date.now() - yieldClock > 50) {
      yieldClock = Date.now();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  async function forLoop(items, fn) {
    for (const it of items || []) {
      try {
        await fn(it);
      } catch (e) {
        if (e instanceof LoopSignal && e.kind === "break") break;
        if (e instanceof LoopSignal && e.kind === "continue") continue;
        throw e;
      }
      await maybeYield();
    }
  }

  // sh2.guard — this debashcl build wraps every command in it. Minimal
  // semantics: pass the result through (exec already records status); a
  // future `set -e` would throw here on falsy.
  function guard(value) { return value; }

  // && and || lowered to closures over async fns.
  async function and(fnA, fnB) { return !!(await fnA()) && !!(await fnB()); }
  async function or(fnA, fnB) { return !!(await fnA()) || !!(await fnB()); }

  // $((...)) in argument position — evaluate and stringify (the result
  // is a shell word, not a number). The compiler emits a SYNC arrow and
  // calls this without await, so it must be synchronous.
  function arithEval(fn) { return String(fn()); }

  // ─── arrays: arr=(a b c), ${arr[i]}, ${#arr[@]}, arr+=(x) ────
  function setArray(name, arr) {
    vars.set(name, (arr || []).map(String));
  }
  // arr+=(x y) — append items to an array variable.
  function setArrayAppend(name, arr) {
    const existing = vars.get(name);
    const list = Array.isArray(existing)
      ? existing.map(String)
      : (existing !== undefined && existing !== "" ? [String(existing)] : []);
    for (const item of arr || []) list.push(String(item));
    vars.set(name, list);
  }
  function arrayIndex(name, idx) {
    const v = vars.get(name);
    const i = Number(expandOperand(String(idx)));   // "$i" → value
    if (Array.isArray(v)) return String(v[i] ?? "");
    if (vars.has(name)) return i === 0 ? String(v) : "";
    return "";
  }
  function arrayLen(name) {
    const v = vars.get(name);
    if (Array.isArray(v)) return String(v.length);
    if (vars.has(name)) return "1";
    return "0";
  }
  // ${arr[@]} spreads / slice results — the emitter wraps them in join
  function join(v) {
    return Array.isArray(v) ? v.join(" ") : String(v);
  }

  // ─── compound assignment: a+=2, x+=s, a*=3, a<<=1 ... ────────
  // bash semantics: += concatenates strings (unless the variable is
  // integer, which we don't track); the other operators force arithmetic
  // (integer, like bash).
  function assign(name, op, value) {
    const cur = String(getVar(name));
    const v = String(value);
    if (op === "+=") { setVar(name, cur + v); return; }
    const n = Number(cur) || 0;
    const m = Number(v) || 0;
    let r;
    if (op === "-=") r = n - m;
    else if (op === "*=") r = n * m;
    else if (op === "/=") r = m === 0 ? 0 : Math.trunc(n / m);
    else if (op === "%=") r = m === 0 ? 0 : Math.trunc(n % m);
    else if (op === "<<=") r = n << m;
    else if (op === ">>=") r = n >> m;
    else if (op === "&=") r = n & m;
    else if (op === "|=") r = n | m;
    else if (op === "^=") r = n ^ m;
    else r = v;
    setVar(name, String(Math.trunc(r)));
  }

  // ─── loop control: break / continue ───────────────────────────
  // The generated JS calls sh2.break()/sh2.continue() inside a
  // forLoop/whileLoop closure. They throw control signals that the
  // enclosing loop catches — the same scheme the sh2perl harness's
  // reference sh2 uses, and the only way to make break/continue act
  // immediately (so the rest of the current iteration is skipped, like
  // real bash). Nested loops each catch at their own level, so break
  // always exits the innermost loop.
  class LoopSignal extends Error {
    constructor(kind) {
      super("loop:" + kind);
      this.kind = kind;
    }
  }
  function breakLoop() { throw new LoopSignal("break"); }
  function continueLoop() { throw new LoopSignal("continue"); }

  // bash integer division / modulo (guarding /0 → 0)
  function idiv(a, b) { const n = Number(b); return n === 0 ? 0 : Math.trunc(Number(a) / n); }
  function imod(a, b) { const n = Number(b); return n === 0 ? 0 : Math.trunc(Number(a) % n); }

  // ! command / condition
  function not(v) { return !v; }

  // record $? after a condition
  function setLastExit(code) { lastStatus = Number(code); }

  async function whileLoop(cond, body) {
    while (await cond()) {
      try {
        await body();
      } catch (e) {
        if (e instanceof LoopSignal && e.kind === "break") break;
        if (e instanceof LoopSignal && e.kind === "continue") continue;
        throw e;
      }
      await maybeYield();
    }
  }

  function caseMatch(value, patterns) {
    const v = String(value);
    for (let i = 0; i < patterns.length; i++) {
      if (globToRegExp(patterns[i]).test(v)) return patterns[i];
    }
    return "";
  }

  function define(name, fn) {
    fns.set(name, fn);
  }

  // ─── brace expansion: {1..3}, {a..c}, {x,y} ──────────────────
  // debashl passes (pre, groups, extra, post) where each group is a list
  // of alternatives and each alternative is a list of parts (strings or
  // {range:[start,end]}). Returns the expanded words (multiple words).
  function brace(pre, groups, _extra, post) {
    const expandParts = (parts) => parts.map((p) => {
      if (p && typeof p === "object" && p.range) {
        const [a, b] = p.range.map((x) => String(x));
        const num = /^\d+$/.test(a) && /^\d+$/.test(b);
        const out = [];
        const start = num ? Number(a) : a.charCodeAt(0);
        const end = num ? Number(b) : b.charCodeAt(0);
        const step = start <= end ? 1 : -1;
        for (let v = start; step > 0 ? v <= end : v >= end; v += step) {
          out.push(num ? String(v) : String.fromCharCode(v));
        }
        return out;
      }
      return [String(p)];
    }).reduce((acc, arr) => acc.concat(arr), []);
    const groupsArr = Array.isArray(groups) ? groups : [];
    let words = [""];
    for (const group of groupsArr) {
      // A group is a list of alternatives; an alternative is a parts
      // list, or a single part (string or {range}) directly.
      const alts = (Array.isArray(group) ? group : [group])
        .map((alt) => expandParts(Array.isArray(alt) ? alt : [alt]));
      const next = [];
      for (const w of words) for (const alt of alts) for (const a of alt) next.push(w + a);
      words = next;
    }
    return words.map((w) => String(pre || "") + w + String(post || ""));
  }

  // ─── arithmetic: $((expr)) with variables ────────────────────
  function arith(expr) {
    const substituted = String(expr)
      .replace(/\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
        const v = getVar(name);
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : "0";
      });
    const cleaned = substituted.replace(/[^0-9+\-*/%().\s]/g, "");
    if (!cleaned.trim()) return 0;
    try {
      // eslint-disable-next-line no-new-func
      const val = Function(`"use strict"; return (${cleaned});`)();
      return typeof val === "number" && Number.isFinite(val) ? Math.trunc(val) : 0;
    } catch {
      return 0;
    }
  }

  // ─── parameter expansion: ${x:-default} etc. ─────────────────
  // debashl encodes the operator as `op`: "-",":-","+",":+","=",":=",
  // "?",":?","#","##","%","%%","slice". #/##/%/%% carry the pattern
  // in rest[0]; slice carries start/len.
  function trimByPattern(s, pattern, fromStart, longest) {
    const str = String(s);
    const p = String(pattern);
    if (!/[?*[]/.test(p)) {
      if (fromStart && str.startsWith(p)) return str.slice(p.length);
      if (!fromStart && str.endsWith(p)) return str.slice(0, str.length - p.length);
      return str;
    }
    const body = globToRegExp(p).source.replace(/^\^|\$$/g, "");
    const re = new RegExp((fromStart ? "^" : "") + body + (fromStart ? "" : "$"));
    const m = str.match(re);
    if (!m) return str;
    return fromStart ? str.slice(m[0].length) : str.slice(0, str.length - m[0].length);
  }

  function param(op, name, ...rest) {
    const has = vars.has(name) || (env && env[name] !== undefined);
    const val = getVar(name);
    const isSet = has && String(val).length > 0;
    const defaultVal = rest.length ? String(rest[0]) : "";
    switch (op) {
      case "-": return has ? val : defaultVal;
      case ":-": return isSet ? val : defaultVal;
      case "+": return has ? defaultVal : "";
      case ":+": return isSet ? defaultVal : "";
      case "=": if (!has) setVar(name, defaultVal); return getVar(name);
      case ":=": if (!isSet) setVar(name, defaultVal); return getVar(name);
      case "?": if (!has) throw new Error(`bash: ${name}: ${defaultVal || "parameter not set"}`);
        return val;
      case ":?": if (!isSet) throw new Error(`bash: ${name}: ${defaultVal || "parameter not set"}`);
        return val;
      case "#": return trimByPattern(val, defaultVal, true, false);
      case "##": return trimByPattern(val, defaultVal, true, true);
      case "%": return trimByPattern(val, defaultVal, false, false);
      case "%%": return trimByPattern(val, defaultVal, false, true);
      case "slice": {
        const start = Number(expandOperand(String(rest[0]))) || 0;
        const len = rest.length > 1 ? Number(expandOperand(String(rest[1]))) : undefined;
        return len === undefined ? String(val).slice(start) : String(val).slice(start, start + len);
      }
      default: return val;
    }
  }

  return {
    sh2: {
      exec, pipeline, capture, captureWords, redirect, test,
      forLoop, whileLoop, caseMatch, define, brace, param, arith,
      guard, and, or, arithEval,
      setArray, setArrayAppend, arrayIndex, arrayLen, join,
      assign,
      "break": breakLoop, "continue": continueLoop,
      idiv, imod, not, setLastExit,
      getVar, setVar,
      // the otranspilerl estree backend reads/writes sh2.lastExit
      get lastExit() { return lastStatus; },
      set lastExit(v) { lastStatus = Number(v); },
      // $1..$9 / $@ — the native estree reads sh2.positional
      get positional() { return scriptArgs; },
      set positional(v) { scriptArgs = Array.isArray(v) ? v.map(String) : []; },
      // minimal sync bridges for the native estree backend's common shapes
      _g: (name) => getVar(name),
      // node-style fs bridge for the native estree backend (file tests,
      // `> file` writes): sh2.fs.lstat/stat resolve to mode-bearing stat
      // objects, writeFile/readFile/readdir map onto the VirtualFS.
      fs: {
        async lstat(p) {
          const st = await fs.stat(p).catch(() => null);
          if (!st) {
            const e = new Error("ENOENT: no such file or directory, lstat '" + p + "'");
            e.code = "ENOENT";
            throw e;
          }
          const mode = st.type === "dir" ? 0o40000 : st.type === "file" ? 0o100000 : 0;
          return {
            mode, size: st.size || 0,
            isDirectory: () => st.type === "dir",
            isFile: () => st.type === "file",
          };
        },
        stat: async (p) => {
          const st = await fs.stat(p).catch(() => null);
          if (!st) {
            const e = new Error("ENOENT: no such file or directory, stat '" + p + "'");
            e.code = "ENOENT";
            throw e;
          }
          const mode = st.type === "dir" ? 0o40000 : st.type === "file" ? 0o100000 : 0;
          return {
            mode, size: st.size || 0,
            isDirectory: () => st.type === "dir",
            isFile: () => st.type === "file",
          };
        },
        writeFile: async (p, data) => { await fs.write(p, String(data ?? "")); },
        readFile: async (p) => { const b = await fs.read(p).catch(() => ""); return typeof b === "string" ? b : new TextDecoder().decode(b); },
        readdir: async (p) => { try { return await fs.list(p); } catch { return []; } },
        mkdir: async (p) => { await fs.write(p + "/.directory", ""); },
      },
      // the native estree reads sh2.cwd as a value (getter — always current)
      get cwd() { return (fs.cwd !== undefined ? fs.cwd : "/") || "/"; },
      cwdFn: () => (fs.cwd !== undefined ? fs.cwd : "/") || "/",
      functions: fns,
      // `grep P` idiom → filter text by pattern (substring/regex)
      grepText(text, patterns, invert) {
        const s = String(text);
        const lines = s.split("\n");
        const hit = (l) => (patterns || []).some((p) => {
          try { return new RegExp(p).test(l); } catch { return l.includes(String(p)); }
        });
        const kept = lines.filter((l) => (invert ? !hit(l) : hit(l)));
        return kept.join("\n") + (s.endsWith("\n") ? "\n" : "");
      },
      // a tiny SYNC builtin table for the native estree backend (echo /
      // date / pwd / true / false) — everything else needs the async
      // shellExec bridge and refuses loudly.
      builtin(name, argsArr) {
        const a = (argsArr || []).map(String);
        switch (name) {
          case "echo": return a.join(" ") + "\n";
          case "printf": return a.join(" ") + "\n";
          case "true": return "";
          case "false": return "";
          case "date": return new Date().toString() + "\n";
          case "pwd": return ((fs.cwd !== undefined ? fs.cwd : "/") || "/") + "\n";
          case "cd": {
            const target = (a[0] || (env && env.HOME) || "/").replace(/\/+$/, "") || "/";
            if (fs && fs.cwd !== undefined) fs.cwd = target;
            lastStatus = 0;
            return "";
          }
          case "test": {
            // [ -f x ] / [ -d x ] / -n / -z / nonempty — sync via statSync
            // (local mounts), exit code in lastStatus.
            const op = a[0], operand = String(a[1] ?? "");
            let r = false;
            if (op === "-f" || op === "-d" || op === "-e") {
              let st = null;
              try { st = fs.statSync ? fs.statSync(operand) : null; } catch { st = null; }
              if (op === "-e") r = !!st;
              else if (op === "-f") r = !!(st && st.type === "file");
              else r = !!(st && st.type === "dir");
            } else if (op === "-n") r = operand.length > 0;
            else if (op === "-z") r = operand.length === 0;
            else r = operand !== "";
            lastStatus = r ? 0 : 1;
            return "";
          }
          default:
            throw new Error("sh2.builtin('" + name + "'): the sync builtin bridge needs the async shell; try `bash` for this construct");
        }
      },
      // the native estree backend's *Sync pipeline/capture/redirect forms
      // need the async bridge — refuse loudly rather than mis-run.
      captureWordsSync() {
        throw new Error("command substitution needs the async capture bridge; try `bash '$(...)'`");
      },
      pipelineSync() {
        throw new Error("pipelines need the async pipeline bridge; try `bash` for this construct");
      },
      redirectSync() {
        throw new Error("redirection needs the async redirect bridge; try `bash` for this construct");
      },
      async fnCall(name, argsArr) {
        const fn = fns.get(name);
        if (typeof fn !== "function") throw new Error("sh2.fnCall: no function '" + name + "'");
        const prev = scriptArgs;
        scriptArgs = (argsArr || []).map(String);
        let r;
        try {
          r = fn();
          if (r && typeof r.then === "function") r = await r;
        } finally {
          scriptArgs = prev;
        }
        lastStatus = r === false ? 1 : 0;
        return r;
      },
      async callDirect(name, fn, argsArr) {
        // `f …` — invoke the registered function body with positional args.
        if (typeof fn !== "function") throw new Error("sh2.callDirect: no function '" + name + "'");
        const prev = scriptArgs;
        scriptArgs = (argsArr || []).map(String);
        let r;
        try {
          r = fn();
          if (r && typeof r.then === "function") r = await r;
        } finally {
          scriptArgs = prev;
        }
        lastStatus = r === false ? 1 : 0;
        return r;
      },
    },
    get lastStatus() { return lastStatus; },
  };
}
