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

import { isReadonly } from "./env.js";

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
    // readonly guard — refuse reassignment (bash: "readonly variable",
    // $? = 1). Check the base name for indexed writes ("arr[$i]").
    const base = s.lastIndexOf("[") > 0 && s.endsWith("]") ? s.slice(0, s.lastIndexOf("[")) : s;
    if (isReadonly(base)) {
      lastStatus = 1;
      return;
    }
    const val = value === undefined || value === null ? "" : String(value);
    // "arr[$i]" — array element assignment (the compiler passes the
    // index unexpanded)
    const b = s.lastIndexOf("[");
    if (b > 0 && s.endsWith("]")) {
      const arrName = s.slice(0, b);
      const idx = Number(expandOperand(s.slice(b + 1, -1)));
      // a mem handle (\u0001mem:<name>:<off>) — a C pointer write: the
      // element `off + idx` of the variable the pointer aliases (the
      // idxassign lowering of `a[j] = v` on a pointer param)
      if (/^\u0001mem:/.test(arrName) && Number.isFinite(idx)) {
        memStore1(memAdvance(arrName, Number(idx) || 0), val);
        return;
      }
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
    const buf = { out: "", stdin: "", stdinPos: 0 };
    mode = { type: "pipe", buf };
    try {
      for (const fn of fns) {
        buf.stdin = buf.out;  // previous stage's output becomes this stdin
        buf.out = "";
        const r = await fn();
        // a sync builtin stage (sh2.builtin — echo/printf) RETURNS its
        // output rather than writing the mode buffer — feed it through,
        // the same as pipelineSync does
        if (typeof r === "string" && r) buf.out += r;
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
    // Native writes bypass the mode buffer: the estree emitter's
    // native-echo lowering (echo/printf inside a sink-eligible function
    // compile to `process.stdout.write(...)` directly — see the
    // NATIVE_ECHO_FNS analysis) does not consult `mode`. The generated
    // code's `process.stdout` IS this same `stdout` object (the otRt
    // shim shares it), so wrapping its write during the capture routes
    // those native writes into the buffer too — a comparator defined in
    // one program and captured in another (`cmp_call` → sh2.capture)
    // lands its echoed -1/0/1 here instead of the terminal.
    const stdoutObj = stdout;
    const origWrite = stdoutObj && typeof stdoutObj.write === "function" ? stdoutObj.write : null;
    let inCapture = true;
    if (origWrite) {
      stdoutObj.write = (s) => {
        if (inCapture) { buf.out += String(s); return true; }
        return origWrite(s);
      };
    }
    try {
      await fn();
    } finally {
      inCapture = false;
      if (origWrite) stdoutObj.write = origWrite;
      mode = prev;
    }
    return buf.out.replace(/\n+$/, "");  // command substitution strips trailing newlines
  }

  // SYNC variants the estree emitter uses for sync builtins (no await —
  // the sync builtins RETURN their output string, so captureSync just
  // returns the arrow's result; pipelineSync mirrors the async pipeline
  // without awaiting).
  function captureSync(fn) {
    const r = fn();
    if (r && typeof r.then === "function") {
      throw new Error("captureSync: async result (emit path expects a sync builtin)");
    }
    const s = r === undefined || r === null ? "" : typeof r === "string" ? r : String(r);
    return s.replace(/\n+$/, "");
  }

  function pipelineSync(fns) {
    const prev = mode;
    const buf = { out: "", stdin: "" };
    mode = { type: "pipe", buf };
    let finalOut;
    try {
      for (const fn of fns) {
        if (typeof fn === "function") {
          // a command stage: previous stage's output becomes its stdin;
          // a sync builtin RETURNS its output (no mode-buffer write), so
          // the return value is the stage's output
          buf.stdin = buf.out;
          buf.out = "";
          const r = fn();
          if (r && typeof r.then === "function") {
            throw new Error("pipelineSync: async stage (emit path expects sync builtins)");
          }
          if (typeof r === "string" && r) buf.out += r;
        } else {
          // a literal stage (e.g. `(sh2.lastExit = 0, "test output" + "\n")`)
          // — the data flowing through the pipeline
          buf.out = String(fn ?? "");
        }
      }
    } finally {
      mode = prev;
    }
    finalOut = buf.out;
    if (prev.type === "capture" || prev.type === "pipe" || prev.type === "redirect") prev.buf.out += finalOut;
    else if (finalOut) stdout.write(finalOut);
    return finalOut;
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
      // `${name+x}` — the "defined" marker (batch `if defined NAME`:
      // true even when set-but-empty, false when unset). The bracket
      // tokenizer can't express it, so handle it before parsing.
      const m = /^!?\$\{([A-Za-z_][A-Za-z0-9_]*)\+x\}$/.exec(String(expr));
      if (m) {
        const defined = vars.has(m[1]) || (env && env[m[1]] !== undefined);
        return m[0].startsWith("!") ? !defined : defined;
      }
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
    // bash `[[ a < b ]]` / `[[ a > b ]]` are LEXICOGRAPHIC string
    // comparisons (`[[ 5 < 10 ]]` is false — "5" > "1"); the numeric
    // orderings are -lt/-le/-gt/-ge.
    if (op === "<") return String(a) < String(b);
    if (op === ">") return String(a) > String(b);
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
    // a mem handle (`\u0001mem:<name>:<off>`) — a C pointer walk: the
    // element `off + idx` of the variable the pointer aliases. The c
    // frontend lowers a POINTER param's `a[j]` reads to arrayIndex on
    // the handle the param holds (sort_ints), while my_qsort's array-name
    // pointers pass the bare name — both must work.
    if (/^\u0001mem:/.test(String(name))) return memLoad1(memAdvance(String(name), Number(idx) || 0));
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
  // ${arr[@]} / "${arr[@]}" — the full element list. The estree
  // emitter's native echo lowering calls `sh2.arrayItems(name)` and
  // wraps the result (`[items].flat().join(" ")`), so an array returns
  // the elements, a set scalar the value, an unset name "" (which the
  // wrap flattens/joins to the same empty string bash yields).
  function arrayItems(name) {
    const v = vars.get(name);
    if (Array.isArray(v)) return v.map(String);
    if (vars.has(name) && v !== undefined) return String(v);
    return "";
  }
  // strcmp(a, b) — the C strcmp bridge (the c frontend's runtime-arg
  // strcmp): the sign of the lexicographic comparison (-1/0/1), like C.
  function strcmp(a, b) {
    const sa = String(a ?? ""), sb = String(b ?? "");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  // ${arr[@]} spreads / slice results — the emitter wraps them in join
  function join(v) {
    return Array.isArray(v) ? v.join(" ") : String(v);
  }

  // ─── stdin line cursor (the c frontend's read_line bridge) ───────
  // The shell seeds `sh2.stdin` with the current command's pipe input
  // before each transpiled program runs; readLine() pulls the next line
  // ("" at EOF). A C `read_line()` lowers to this call, so a sourced C
  // program can slurp its stdin without a bash `read` builtin.
  let stdinData = "";
  let stdinPos = 0;
  let stdinAtEOF = false;
  function readLine() {
    // a C function as a PIPELINE STAGE: consume the pipe's stdin (the
    // previous stage's captured stdout — the `printf … | slurp2` idiom)
    if (mode.type === "pipe" && mode.buf && typeof mode.buf.stdin === "string" && mode.buf.stdin.length) {
      const s = mode.buf.stdin;
      const pos = mode.buf.stdinPos || 0;
      if (pos < s.length) {
        const nl = s.indexOf("\n", pos);
        let line;
        if (nl === -1) { line = s.slice(pos); mode.buf.stdinPos = s.length; }
        else { line = s.slice(pos, nl); mode.buf.stdinPos = nl + 1; }
        if (line.endsWith("\r")) line = line.slice(0, -1);
        return line;
      }
    }
    if (stdinPos >= stdinData.length) {
      stdinAtEOF = true;
      return "";
    }
    stdinAtEOF = false;
    const nl = stdinData.indexOf("\n", stdinPos);
    let line;
    if (nl === -1) {
      line = stdinData.slice(stdinPos);
      stdinPos = stdinData.length;
    } else {
      line = stdinData.slice(stdinPos, nl);
      stdinPos = nl + 1;
    }
    if (line.endsWith("\r")) line = line.slice(0, -1);   // CRLF input
    return line;
  }
  // getline(&buf, &size, stdin) — the c frontend's standard-API bridge:
  // reads the next line into the variable `name`, returns its length (the
  // ssize_t getline contract), or -1 at EOF (the buffer is left empty).
  function getLine(name) {
    const line = readLine();
    if (stdinAtEOF) {
      setVar(name, "");
      return -1;
    }
    setVar(name, line);
    return line.length;
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

  // Sync twin of whileLoop — the estree lowers provably-sync loops
  // (cond + body await-free) to `sh2.whileLoopSync(cond, body)` with NO
  // per-iteration promises. Same break/continue LoopSignal contract.
  function whileLoopSync(cond, body) {
    while (cond()) {
      try {
        body();
      } catch (e) {
        if (e instanceof LoopSignal && e.kind === "break") break;
        if (e instanceof LoopSignal && e.kind === "continue") continue;
        throw e;
      }
    }
  }

  // C float arithmetic (the c-sh-go frontend's `fparith` call — the
  // `(expr)` string over $vars, evaluated with JS float semantics).
  function fparith(s) {
    const src = String(s).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => {
      const v = vars.get(n) ?? (env && env[n]) ?? "";
      const f = Number(String(v));
      return Number.isFinite(f) ? String(f) : "0";
    });
    try {
      const f = Function('"use strict"; return (' + src + ');')();
      return Number.isFinite(Number(f)) ? String(f) : "0";
    } catch {
      return "0";
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

  // ── sh2.mem — pointer emulation (the C frontend's mem.* seam) ────
  // Pointers lower to (allocation_id, offset) handles encoded as tagged
  // strings `\u0001mem:<id>:<offset>`. Slice 1: pointers to NAMED
  // variables — the allocation is the variable itself (id = name,
  // offset 0); load/store read/write the sh2 store. Slice 2 (malloc):
  // numeric ids over a typed slot arena with real element offsets.
  function memAddrOf(name) {
    return "\u0001mem:" + String(name) + ":0";
  }
  function memLoad1(h) {
    const m = /^\u0001mem:([^:]*):(-?\d+)$/.exec(String(h));
    if (!m) return "";
    // slice-1 handle: the offset is an ELEMENT index — 0 is the var
    // itself (or its first element), n reads the n-th element of a
    // shell array (`name[n]` — the runtime's array-key convention).
    const idx = Number(m[2]);
    return idx === 0 ? getVar(m[1]) : getVar(m[1] + "[" + idx + "]");
  }
  function memStore1(h, v) {
    if (process.env.SH2_DEBUG_MEM) process.stderr.write(`[memStore1] h=${JSON.stringify(h)} v=${v}\n`);
    const m = /^\u0001mem:([^:]*):(-?\d+)$/.exec(String(h));
    if (!m) return;
    const idx = Number(m[2]);
    const name = m[1];
    const val = String(v ?? "");
    if (idx !== 0) { setVar(name + "[" + idx + "]", val); return; }
    // index 0: write the element if the var is an array (keep the
    // array), otherwise the var itself
    if (Array.isArray(vars.get(name))) setVar(name + "[0]", val);
    else setVar(name, val);
  }
  // memAdvance(h, delta) — a C pointer increment: return the handle for
  // the element `delta` positions further on (`p + 1` / `p++`).
  function memAdvance(h, delta) {
    if (!/^\u0001mem:/.test(String(h))) h = memAddrOf(h);
    const m = /^\u0001mem:([^:]*):(-?\d+)$/.exec(String(h));
    if (!m) return String(h);
    return "\u0001mem:" + m[1] + ":" + (Number(m[2]) + (Number(delta) || 0));
  }
  const memArena = {};
  let memSeq = 0;
  function memAlloc(size) {
    const id = ++memSeq;
    const n = Math.max(0, Math.floor(Number(size) || 0));
    memArena[id] = new Array(n).fill(0);
    return `\u0001mem:${id}:${n}`;
  }
  function memElemSize(type) {
    if (typeof type === "number") return Math.max(1, Math.floor(type));
    const t = String(type ?? "int");
    const sizes = {
      char: 1, "signed char": 1, "unsigned char": 1, short: 2, "short int": 2,
      int: 4, "unsigned int": 4, long: 8, "long int": 8, "long long": 8,
      float: 4, double: 8, "void*": 8, ptr: 8, pointer: 8,
      int8: 1, int16: 2, int32: 4, int64: 8,
    };
    return sizes[t] ?? 1;
  }
  function memArenaOf(h) {
    const m = /^\u0001mem:([^:]+):(-?\d+)$/.exec(String(h));
    if (!m) return null;
    const id = m[1];
    if (!/^\d+$/.test(id)) return null;      // slice-1 named-var handle
    const arr = memArena[Number(id)];
    if (!arr) return null;                    // freed / never allocated
    return { arr, size: Math.max(1, Number(m[2]) || 1) };
  }
  function memLoad(h, offset, type) {
    // a bare variable name is a handle for its own element 0 (a pointer
    // IS a name — `sum_first a 3` and `sum_first "$(addr a)" 3` both
    // walk the array `a`)
    if (!/^\u0001mem:/.test(String(h))) h = memAddrOf(h);
    const a = memArenaOf(h);
    if (!a) return memLoad1(h);
    const i = (Number(offset) || 0) * memElemSize(type);
    return i >= 0 && i < a.arr.length ? String(a.arr[i]) : "";
  }
  function memStore(h, offset, type, v) {
    if (!/^\u0001mem:/.test(String(h))) h = memAddrOf(h);
    const a = memArenaOf(h);
    if (!a) return memStore1(h, v);
    const i = (Number(offset) || 0) * memElemSize(type);
    if (i >= 0 && i < a.arr.length) a.arr[i] = String(v ?? "");
  }
  function memFree(h) {
    const m = /^\u0001mem:([^:]+):(-?\d+)$/.exec(String(h));
    if (!m || !/^\d+$/.test(m[1])) return;
    delete memArena[Number(m[1])];
  }

  return {
    sh2: {
      exec, pipeline, capture, captureSync, pipelineSync, captureWords, redirect, test,
      forLoop, whileLoop, whileLoopSync, caseMatch, define, brace, param, arith, fparith,
      guard, and, or, arithEval,
      setArray, setArrayAppend, arrayIndex, arrayLen, arrayItems, join,
      strcmp,
      readLine,
      // sh2.stdin — the shell seeds the current pipe input before each
      // transpiled program; the c frontend's read_line() consumes it.
      set stdin(v) { stdinData = String(v ?? ""); stdinPos = 0; stdinAtEOF = false; },
      get stdin() { return stdinData; },
      getLine,
      memAddrOf: memAddrOf, memLoad, memStore, memAlloc, memElemSize, memFree, memAdvance,
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
      // $0 / the script name (sh2.argv0 — settable so `bash script.sh`
      // and `set --` can change it per line)
      get argv0() { return argv0; },
      set argv0(v) { argv0 = String(v ?? "bash"); },
      // the native store the otranspilerl estree backend reads/writes
      // (`sh2.vars.x` — see sh2perl/src/estree.rs native-store fold;
      // generated code adds the env fallback itself as
      // `sh2.vars.x ?? (process.env.x ?? "")`, so a Map miss must read
      // as undefined, not ""). A live Proxy over the internal Map keeps
      // every setVar/getVar path and the native property access in sync.
      vars: new Proxy(Object.create(null), {
        get: (t, k) => (typeof k === "string" ? vars.get(k) : undefined),
        set: (t, k, v) => { if (typeof k === "string") setVar(k, v); return true; },
        has: (t, k) => typeof k === "string" && vars.has(k),
        deleteProperty: (t, k) => { if (typeof k === "string") vars.delete(k); return true; },
        ownKeys: () => [...vars.keys()],
        getOwnPropertyDescriptor: (t, k) =>
          vars.has(k)
            ? { value: vars.get(k), writable: true, enumerable: true, configurable: true }
            : undefined,
      }),
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
        // `mktemp -d` (the native estree lowers it to sh2.fs.mkdtemp):
        // create a unique directory under the prefix and resolve to its
        // path (the `.directory` marker is the VirtualFS dir convention).
        mkdtemp: async (prefix) => {
          const base = String(prefix ?? "/tmp/tmp.");
          for (let i = 0; i < 20; i++) {
            const rnd = Math.random().toString(36).slice(2, 8);
            const p = base + rnd;
            const st = await fs.stat(p).catch(() => null);
            if (!st) {
              await fs.write(p + "/.directory", "");
              return p;
            }
          }
          throw new Error("mkdtemp: could not create a unique dir under " + base);
        },
        // `rm` / `unlink` (the native estree lowers rm -f/-r and unlink to
        // these): remove a file or directory tree from the VirtualFS.
        unlink: async (p) => { await fs.remove(p); },
        rm: async (p) => { await fs.remove(p); },
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
      // fileTest(flag, path) — `[ -e/-f/-d path ]`: the estree lowers the
      // sync file tests to this (statSync on local mounts), returning the
      // boolean; the renderer sets lastExit from it.
      fileTest(flag, p) {
        let st = null;
        try { st = fs.statSync ? fs.statSync(String(p)) : null; } catch { st = null; }
        if (flag === "-f") return !!(st && st.type === "file");
        if (flag === "-d") return !!(st && st.type === "dir");
        return !!st;   // -e and anything else: exists
      },
      // `grepMatches(text, pattern, flags)` — the `grep -o` lift: the
      // array of matched substrings (grep -o prints each match on its
      // own line). flags: "E" (pattern is ERE — as-is), "F" (fixed
      // string), "i" (case-insensitive); the default is BRE (translated).
      grepMatches(text, pattern, flags) {
        const s = String(text ?? "");
        const fl = String(flags ?? "");
        let body = String(pattern ?? "");
        try {
          if (fl.includes("F")) {
            body = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          } else if (!fl.includes("E")) {
            body = body
              .replace(/\\+/g, "+").replace(/\\\?/g, "?")
              .replace(/\\\(/g, "(").replace(/\\\)/g, ")")
              .replace(/\\\|/g, "|").replace(/\\\{/g, "{").replace(/\\\}/g, "}");
          }
          const g = fl.includes("i") ? "gi" : "g";
          const re = new RegExp(body, g);
          const matches = s.match(re) || [];
          lastStatus = matches.length > 0 ? 0 : 1;
          return matches.join("\n");   // grep -o: one match per line
        } catch {
          lastStatus = 2;
          return [];
        }
      },
      // a tiny SYNC builtin table for the native estree backend (echo /
      // date / pwd / true / false) — everything else needs the async
      // shellExec bridge and refuses loudly.
      builtin(name, argsArr) {
        const a = (argsArr || []).map(String);
        switch (name) {
          case "echo": return a.join(" ") + "\n";
          case "printf": {
            // the bash printf builtin: interpret \n \t \r \\ escapes
            // (the emitter passes format strings with literal backslashes)
            let out = "";
            for (const s of a) {
              out += s.replace(/\\n/g, "\n").replace(/\\t/g, "\t")
                .replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
            }
            return out;
          }
          case "true": return "";
          case "false": return "";
          case "date": return new Date().toString() + "\n";
          case "pwd": return ((fs.cwd !== undefined ? fs.cwd : "/") || "/") + "\n";
          case "cd": {
            const target = (a[0] || (env && env.HOME) || "/").replace(/\/+$/, "") || "/";
            if (fs && fs.cwd !== undefined) {
              fs.cwd = target;
              if (env) env.PWD = target;   // keep $PWD honest across native/transpiled
            }
            lastStatus = 0;
            return "";
          }
          case "export": {
            // `export X="value"` — debashl splits this into ["X=", "value"]
            // (a quoted value with spaces arrives as its own arg), so a
            // trailing `NAME=` takes the next arg as its value.
            let pending = null;
            for (const a0 of argsArr || []) {
              const arg = String(a0 ?? "");
              if (pending !== null) { vars.set(pending, arg); pending = null; continue; }
              if (arg.endsWith("=")) { pending = arg.slice(0, -1); continue; }
              const eq = arg.indexOf("=");
              if (eq > 0) { vars.set(arg.slice(0, eq), arg.slice(eq + 1)); continue; }
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) vars.set(arg, "");
            }
            if (pending !== null) vars.set(pending, "");
            return "";
          }
          case "ls": {
            // SYNC ls for sourced function bodies (debashl renders a
            // single-command body through sh2.builtin). Basic listing via
            // fs.listSync/statSync — the async builtin ls in the shell
            // handles the pretty interactive form.
            let long = false;
            const names = [];
            for (const x of a) {
              if (x === "-l" || x === "-la" || x === "-al") long = true;
              else if (x.startsWith("-")) continue;
              else names.push(x);
            }
            if (!names.length) names.push(".");
            let out = "";
            for (const d of names) {
              const base = d.replace(/\/+$/, "") || "/";
              let st = null;
              try { st = fs.statSync ? fs.statSync(d) : null; } catch {}
              if (st && st.type === "file") { out += base.split("/").filter(Boolean).pop() + "\n"; continue; }
              const entries = fs.listSync ? fs.listSync(d) : null;
              if (entries === null) { out += `ls: ${d}: No such file or directory\n`; continue; }
              for (const e of entries) {
                const clean = e.replace(/\/$/, "");
                let est = null;
                try { est = fs.statSync ? fs.statSync(base + "/" + clean) : null; } catch {}
                const isDir = est && est.type === "dir";
                out += (isDir ? clean + "/" : clean) + (long ? "\n" : "  ");
              }
              out += "\n";
            }
            // write, don't return — a function body's return value is only
            // used for $?, so output must reach stdout directly (the same
            // pattern grepMatches uses)
            if (out && stdout && typeof stdout.write === "function") stdout.write(out);
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
            else {
              // `${name+x}` — the "defined" marker (batch `if defined NAME`;
              // true even when the var is set-but-empty, false when unset)
              const m = /^!?\$\{([A-Za-z_][A-Za-z0-9_]*)\+x\}$/.exec(op);
              if (m) {
                const defined = vars.has(m[1]) || (env && env[m[1]] !== undefined);
                r = op[0] === "!" ? !defined : defined;   // `if not defined`
              }
              else r = operand !== "";
            }
            lastStatus = r ? 0 : 1;
            return "";
          }
          default:
            // bash semantics for an unknown sync command: report it,
            // set $? = 127, and CONTINUE — the script keeps running
            // (a command substitution yields ""). Only commands the
            // async shellExec bridge can run used to refuse loudly
            // here; bash itself just says "command not found".
            if (stderr && typeof stderr.write === "function") stderr.write(String(name) + ": command not found\n");
            lastStatus = 127;
            return "";
        }
      },
      // captureSync / pipelineSync are the real sync variants defined
      // above (the estree emitter uses them for sync builtins).
      captureWordsSync() {
        throw new Error("command substitution needs the async capture bridge; try `bash '$(...)'`");
      },
      redirectSync() {
        throw new Error("redirection needs the async redirect bridge; try `bash` for this construct");
      },
      // Sync-capable fnCall: the estree's PROVABLY-SYNC function path
      // (fn_call_sync_set) emits `sh2.fnCall(...)` WITHOUT await — so for
      // an await-free body this must return the VALUE, not a promise. An
      // async body still returns a promise (the async dispatch awaits it;
      // the sync no-await path is only used for bodies proven await-free).
      fnCall(name, argsArr) {
        const fn = fns.get(name);
        if (typeof fn !== "function") throw new Error("sh2.fnCall: no function '" + name + "'");
        const prev = scriptArgs;
        scriptArgs = (argsArr || []).map(String);
        let r;
        try {
          r = fn();
        } catch (e) {
          scriptArgs = prev;
          throw e;
        }
        if (r && typeof r.then === "function") {
          return r.then((v) => {
            scriptArgs = prev;
            lastStatus = v === false ? 1 : 0;
            return v;
          });
        }
        scriptArgs = prev;
        lastStatus = r === false ? 1 : 0;
        return r;
      },
      // `f …` — invoke a DIRECT-registered function body (the estree's
      // native-direct subset); same sync-capable contract as fnCall.
      callDirect(name, fn, argsArr) {
        if (typeof fn !== "function") throw new Error("sh2.callDirect: no function '" + name + "'");
        const prev = scriptArgs;
        scriptArgs = (argsArr || []).map(String);
        let r;
        try {
          r = fn();
        } catch (e) {
          scriptArgs = prev;
          throw e;
        }
        if (r && typeof r.then === "function") {
          return r.then((v) => {
            scriptArgs = prev;
            lastStatus = v === false ? 1 : 0;
            return v;
          });
        }
        scriptArgs = prev;
        lastStatus = r === false ? 1 : 0;
        return r;
      },
    },
    get lastStatus() { return lastStatus; },
  };
}
