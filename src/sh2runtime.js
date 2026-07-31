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
    return String(s).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|\d+|#|@|\*|\?|\$|\!)\}?/g, (m, name) => {
      const v = getVar(name);
      return Array.isArray(v) ? v.join(" ") : String(v);
    });
  }

  function getVar(name) {
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
    if (vars.has(name)) return vars.get(name);
    if (env && env[name] !== undefined) return String(env[name]);
    return "";
  }

  function setVar(name, value) {
    vars.set(name, value === undefined || value === null ? "" : String(value));
  }

  async function exec(name, argsArr) {
    // User-defined function shadows commands, like in bash.
    if (fns.has(name)) {
      const prevArgs = scriptArgs;
      scriptArgs = (argsArr || []).map(String);
      try {
        await fns.get(name)();
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

  function tokenizeTest(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1, out = "";
        while (j < s.length && s[j] !== q) {
          if (s[j] === "\\" && q === '"' && j + 1 < s.length) { out += s[j + 1]; j += 2; continue; }
          out += s[j++];
        }
        tokens.push(expandOperand(out));
        i = j + 1;
      } else {
        let j = i;
        while (j < s.length && s[j] !== " " && s[j] !== "\t" && s[j] !== '"' && s[j] !== "'") j++;
        tokens.push(expandOperand(s.slice(i, j)));
        i = j;
      }
    }
    return tokens;
  }

  const BIN_OPS = new Set(["=", "!=", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot"]);
  const UNARY_OPS = new Set(["-z", "-n", "-f", "-d", "-e", "-x", "-w", "-r", "-s"]);

  function applyBin(op, a, b) {
    if (op === "=") return String(a) === String(b);
    if (op === "!=") return String(a) !== String(b);
    if (op === "-nt" || op === "-ot") return false;  // no mtime comparison — keep simple
    const na = Number(a), nb = Number(b);
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

  async function forLoop(items, fn) {
    for (const it of items || []) await fn(it);
  }

  async function whileLoop(cond, body) {
    while (await cond()) await body();
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
        const start = Number(rest[0]) || 0;
        const len = rest.length > 1 ? Number(rest[1]) : undefined;
        return len === undefined ? String(val).slice(start) : String(val).slice(start, start + len);
      }
      default: return val;
    }
  }

  return {
    sh2: {
      exec, pipeline, capture, captureWords, redirect, test,
      forLoop, whileLoop, caseMatch, define, brace, param, arith,
      getVar, setVar,
    },
    get lastStatus() { return lastStatus; },
  };
}
