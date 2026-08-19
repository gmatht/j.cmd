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

// ── Ctrl+C / interrupt support ──────────────────────────────────
// The shell can't hard-kill an in-flight async script, but transpiled
// loops call sh2.test() every iteration — so the shell registers an
// interrupt hook per runtime and test() throws as soon as the flag is
// set, aborting the loop (and the whole script) instead of letting it
// burn CPU in the background after Ctrl+C abandons the outer promise.
const interruptHooks = new Set();
export function registerInterruptHook(fn) {
  interruptHooks.add(fn);
  return () => interruptHooks.delete(fn);
}
export function fireInterruptHooks() {
  for (const fn of [...interruptHooks]) {
    try { fn(); } catch {}
  }
}

// Quote a word for a command line (the shell's tokenizer round-trips it).
function quoteWord(w) {
  const s = String(w);
  if (s === "") return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// Glob pattern (case pattern) → RegExp source.
// Glob pattern (case pattern) → RegExp source. Bash globs match ANY
// character — including newlines — so `*`/`?` lower to [\s\S] (a plain
// `.` would stop at \n and a `case` on a multi-line value like
// /dev/webgl/state would never match).
function globToRegExp(pattern) {
  let out = "";
  for (const ch of String(pattern)) {
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}

// ─── integer arithmetic evaluator ($((...)) core) ─────────────
// Tokenizes the substituted expression and evaluates with bash's
// precedence: () > unary- > * / % > + - > << >> > & > ^ > |. / and %
// truncate toward zero (bash integer semantics); the final result is
// truncated too. Returns 0 on malformed input (bash reports the error
// and uses 0). No Function constructor — the sound generators call
// $((...)) ~30K times for the treasure sound; compiling a function per
// call was the dominant cost.
function evalArithInt(src) {
  const s = String(src);
  const toks = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && s[j] >= "0" && s[j] <= "9") j++;
      toks.push(Number(s.slice(i, j)));
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "<<" || two === ">>") { toks.push(two); i += 2; continue; }
    if ("+-*/%()&|^".includes(c)) { toks.push(c); i++; continue; }
    return 0;   // unknown token — malformed
  }
  if (!toks.length) return 0;
  const PREC = (op) => op === "(" ? 0 : op === "|" ? 1 : op === "^" ? 2 : op === "&" ? 3 :
    (op === "<<" || op === ">>") ? 4 : (op === "+" || op === "-") ? 5 :
    (op === "*" || op === "/" || op === "%") ? 6 : 7;
  const apply = (op, a, b) => {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? 0 : Math.trunc(a / b);
      case "%": return b === 0 ? 0 : Math.trunc(a % b);
      case "<<": return a << b;
      case ">>": return a >> b;
      case "&": return a & b;
      case "|": return a | b;
      case "^": return a ^ b;
      case "u-": return -b;
    }
    return 0;
  };
  const vals = [];
  const ops = [];
  let expectVal = true;
  for (const t of toks) {
    if (typeof t === "number") { vals.push(t); expectVal = false; continue; }
    if (t === "(") { ops.push("("); expectVal = true; continue; }
    if (t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") {
        const op = ops.pop();
        const b = vals.pop();
        const a = op === "u-" ? 0 : vals.pop();
        vals.push(apply(op, a, b));
      }
      ops.pop();   // the "("
      expectVal = false;
      continue;
    }
    if (expectVal) {
      // unary minus (bash: -x); unary plus is a no-op
      if (t === "-") { ops.push("u-"); continue; }
      if (t === "+") continue;
    }
    while (ops.length && PREC(ops[ops.length - 1]) >= PREC(t)) {
      const op = ops.pop();
      const b = vals.pop();
      const a = op === "u-" ? 0 : vals.pop();
      vals.push(apply(op, a, b));
    }
    ops.push(t);
    expectVal = true;
  }
  while (ops.length) {
    const op = ops.pop();
    const b = vals.pop();
    const a = op === "u-" ? 0 : vals.pop();
    vals.push(apply(op, a, b));
  }
  const r = vals.length ? vals[vals.length - 1] : 0;
  return Number.isFinite(r) ? Math.trunc(r) : 0;
}

export function createSh2Runtime({ fs, env, shellExec, stdout, stderr, args = [], argv0 = "bash" }) {
  const vars = new Map();      // script-local variables (not exported)
  let bgThreadJobs = 0;        // pending `&` jobs routed to the worker thread
  let interrupted = false;     // Ctrl+C from the shell — test() throws when set
  registerInterruptHook(() => { interrupted = true; });
  const fns = new Map();       // function definitions
  let scriptArgs = [...args];
  let lastStatus = 0;
  let mode = { type: "plain" };  // plain | capture | pipe | redirect

  // Expand a test-expression operand ($var, ${var}, quotes already stripped).
  // Factory-local: it needs getVar for variable expansion.
  function expandOperand(s) {
    // Fast path: no `$` means no expansion — the common case is a plain
    // number / literal index (arrayIndex("map", "123")), which the three
    // regex passes below would otherwise scan pointlessly (the game's
    // per-block cell reads hit this thousands of times per frame).
    const str = String(s);
    if (str.indexOf("$") === -1) return str;
    // ${#arr[@]} — array length · ${#name} — string length (the emitter
    // passes both inside test strings like `[ $i -lt ${#arr[@]} ]`)
    const withLen = str
      .replace(/\$\{#([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g, (m, name) => arrayLen(name))
      .replace(/\$\{#([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => String(getVar(name)).length);
    // `${arr[$i]}` / `$arr[0]` — array ELEMENT reads (a quoted test
    // operand like `[ "${sh_env16[0]}" -gt 0 ]`; the scalar rule below
    // would read the WHOLE array and Number() it to NaN → the shatter
    // generator's shard guard silently became false). The index may be
    // the emitter's `\$`+value artifact or a live `$name` — arrayIndex's
    // expandOperand resolves both.
    const withArr = withLen.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]\}?/g, (m, name, idx) =>
      String(arrayIndex(name, String(idx).trim())));
    return withArr.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|\d+|#|@|\*|\?|\$|\!)\}?/g, (m, name) => {
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
    // EPOCHREALTIME / EPOCHSECONDS — bash's wall-clock special variables.
    // A static env value would go stale; return a LIVE value so the µs
    // clocks in the texture generators and mimecroft (tick/gtick) skip
    // the `date +%s%N` command-substitution fallback. Without this the
    // per-pixel tick() calls ran ~512 date execs through the full
    // command machinery per texture (~8s each) and gtick() ran ~9 per
    // game frame — the startup and keyboard-capture killers. Integer µs
    // matches the consumers' `${var%.*}${var#*.}` dot-strip exactly.
    if (name === "EPOCHREALTIME") return String(Date.now() * 1000);
    if (name === "EPOCHSECONDS") return String(Math.floor(Date.now() / 1000));
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
    // a BOXED pointer survives setVar as-is (String(box) would mangle
    // it to "[object Object]" — shell variables can hold boxes; the
    // shell-boundary text seams stay one-way).
    const isBox = value && typeof value === "object" && Array.isArray(value.arena);
    const val = value === undefined || value === null ? "" : isBox ? value : String(value);
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
        // redundant-write fast path: same value → skip the full-array
        // copy (setVar copies the whole array per element write — the
        // game's loops re-write cells whose value is unchanged, e.g.
        // the gen-time `map[$i]=0` seeding and repeated damage writes).
        if (!isBox && existing[idx] === val) return;
        const list = existing.slice();
        list[idx] = isBox ? value : val;
        vars.set(arrName, list);
        return;
      }
      // not an array (or bad index) — fall through to a plain variable
    }
    vars.set(name, val);
  }

  async function exec(name, argsArr) {
    // Ctrl+C aborts even command-based loop conditions (`while true`
    // transpiles to exec("true"), not test()).
    if (interrupted) throw new Error("interrupted by Ctrl+C");
    // `mode` is a SHARED var — an AWAITED exec lets the game's other
    // async flow (the backgrounded sound precache) set/restore another
    // capture/redirect in between, so the exec's own output routing
    // must use the mode it STARTED with (the worker path already does
    // this — entryMode — the normal path raced it and a `$(cat …)`
    // substitution's script leaked to the terminal as mode=plain).
    const entryMode = mode;
    const isCapTarget = entryMode.type === "capture" && !!entryMode.target;
    if (isCapTarget) entryMode.target = false;
    // ── the `&` thread heuristic: a backgrounded `bash <script>` exec
    // (the texture/sound generators — self-contained pure compute) runs
    // on a WORKER THREAD; the args here are ALREADY evaluated by the
    // generated code (the template literals resolved), so no source
    // parsing is needed. The worker's stdout returns as this exec's
    // output, which the surrounding redirect writes to the target on
    // the MAIN VFS.
    if (bgThreadJobs > 0 && (name === "bash" || name === "/bin/bash") && argsArr && argsArr[0] &&
        typeof argsArr[0] === "string" && argsArr[0].startsWith("/")) {
      // the worker round-trip AWAITS a queued job (seconds — the menu's
      // texture jobs are ahead), during which the main flow keeps
      // running and `mode` (a shared variable) can change — the caller
      // is whatever mode STARTED this exec. Capture it now and write
      // the worker's stdout to THAT sink, so a `$(bash …)` substitution
      // (the sound cache) gets its buffer even if the game interleaved
      // another capture/redirect in between.
      const entryMode = mode;
      try {
        const scriptPath = argsArr[0];
        const scriptText = await fs.read(scriptPath);
        const { bgSubmit, bgPeek } = await import("./bgworker.js");
        const { id, promise } = await bgSubmit(scriptText, argsArr.slice(1));
        await promise;
        const job = bgPeek(id);
        lastStatus = Number(job.code ?? 0);
        const jobOut = job.out || "";
        // The worker returns the script's stdout as this exec's return.
        // It must NOT also write it to the shared mode buffer: the
        // worker round-trip AWAITS a queued job (seconds), during which
        // the main flow's own output lands in whatever capture/redirect
        // mode is active — polluting the substitution buffer (the sound
        // cache's cs_x came back as "  compiling the fragment shader…"
        // + the TSV, header check failed, no cache file). Callers that
        // need the output (redirect, capture) use the string return.
        return jobOut;
      } catch (e) {
        lastStatus = 1;
        return "";
      }
    }
    // User-defined function shadows commands, like in bash.
    if (fns.has(name)) {
      // splice array args (the `$@` listVar contract) — a single arg
      // that is itself an array becomes separate positionals, exactly
      // like the builtin table's flattener.
      const prevArgs = scriptArgs;
      scriptArgs = (() => {
        const flat = [];
        for (const a of argsArr || []) {
          if (Array.isArray(a)) {
            for (const x of a) flat.push((x && typeof x === "object" && Array.isArray(x.arena)) ? x : String(x));
          } else {
            flat.push((a && typeof a === "object" && Array.isArray(a.arena)) ? a : String(a));
          }
        }
        return flat;
      })();
      try {
        const ret = await fns.get(name)();
        // `return N` sets the function's exit status (the transpiler
        // emits the literal as a string). A boolean/void result means
        // the body's commands already recorded $? via exec — leave it.
        if (typeof ret === "string" || typeof ret === "number") {
          lastStatus = Number(ret);
        }
      } catch (e) {
        if (e instanceof ReturnSignal) lastStatus = Number(e.value);
        else throw e;
      } finally {
        scriptArgs = prevArgs;
      }
      return lastStatus === 0;
    }
    const cmdline = quoteWord(name) + (argsArr && argsArr.length
      ? " " + flattenArgs(argsArr).map(quoteWord).join(" ")
      : "");
    const res = await shellExec(cmdline, mode.type === "pipe" ? mode.buf.stdin : "", mode.type);
    lastStatus = res.code;
    if (entryMode.type === "capture" || entryMode.type === "pipe") entryMode.buf.out += res.out;
    else if (entryMode.type === "redirect") entryMode.buf.out += res.out;
    else if (res.out) stdout.write(res.out);
    if (res.err) {
      if (entryMode.type === "redirect") entryMode.buf.err += res.err;
      else stderr.write(res.err);
    }
    // the capture target returns its stdout directly (the capture
    // prefers a string return — the mode buffer is unreliable there
    // because the awaited command lets other output interleave).
    if (isCapTarget) return res.out;
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
    // target: the FIRST exec inside the capture fn is the substituted
    // command — it returns its stdout as the exec's return (both the
    // worker and shellExec paths), which the capture prefers. Anything
    // interleaved AFTER the target is consumed (the game's own echoes
    // while the worker round-trip awaits) is NOT the substitution's
    // output — without the marker it would land in this shared buffer
    // and corrupt cs_x (the sound cache got "  compiling the fragment
    // shader…" + the TSV, header check failed, no cache file).
    mode = { type: "capture", buf, target: true };
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
    let ret;
    try {
      ret = await fn();
    } finally {
      inCapture = false;
      if (origWrite) stdoutObj.write = origWrite;
      mode = prev;
    }
    // the worker path returns the script's stdout as the exec's return
    // (the mode buffer is unreliable there — the awaited job lets other
    // output interleave); the normal path returns a boolean and the
    // output lives in the buffer. Prefer a non-empty string return.
    const capOut = (typeof ret === "string" && ret) ? ret : buf.out;
    return capOut.replace(/\n+$/, "");  // command substitution strips trailing newlines
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
    // Native echo/printf lowering writes directly through the process shim,
    // bypassing the runtime mode buffer. Capture those writes here just as
    // capture() does; otherwise a native write inside an async redirect is
    // lost before the file/device target is flushed.
    const stdoutObj = stdout;
    const stderrObj = stderr;
    // Some embedders (including the headless MIMEcroft harness) expose the
    // generated `process.stdout` as a different object from the runtime's
    // stdout sink. Capture both so native echo lowering cannot bypass the
    // redirect merely because it used the host process shim.
    const hostOut = typeof globalThis !== "undefined" && globalThis.process && globalThis.process.stdout;
    const hostErr = typeof globalThis !== "undefined" && globalThis.process && globalThis.process.stderr;
    const outObjs = [stdoutObj, hostOut].filter((x, i, a) => x && typeof x.write === "function" && a.indexOf(x) === i);
    const errObjs = [stderrObj, hostErr].filter((x, i, a) => x && typeof x.write === "function" && a.indexOf(x) === i);
    const origOuts = outObjs.map((x) => x.write);
    const origErrs = errObjs.map((x) => x.write);
    outObjs.forEach((x) => { x.write = (s) => { buf.out += String(s); return true; }; });
    errObjs.forEach((x) => { x.write = (s) => { buf.err += String(s); return true; }; });
    let ret;
    try {
      ret = await fn();
    } finally {
      outObjs.forEach((x, i) => { x.write = origOuts[i]; });
      errObjs.forEach((x, i) => { x.write = origErrs[i]; });
      mode = prev;
    }
    const handled = { 1: false, 2: false };
    for (const r of redirects) {
      const fd = r.fd || 1;
      // a sync builtin (echo/printf/cat) RETURNS its output string —
      // use it (the async twin of redirectSync's string check); async
      // commands write through the mode buffer and return an object.
      const content = typeof ret === "string" ? ret : (fd === 2 ? buf.err : buf.out);
      handled[fd] = true;
      const target = String(r.target || "");
      // `>&2` / `2>&1` / `&2` — an fd-dup target (the transpiler emits
      // `target: "&2"` for a `>&2` redirect). Route the content to the
      // fd's sink — it is NOT a VFS file named "&2".
      if (target.startsWith("&")) {
        const tfd = Number(target.slice(1));
        if (tfd === 1) { if (content) stdout.write(content); }
        else if (tfd === 2) { if (content) stderr.write(content); }
        else throw new Error(`redirect: no fd ${tfd}`);
        continue;
      }
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
  // ─── test-string arithmetic: `[ "$x" -lt $(( ... )) ]` ──────
  // The estree backend renders arithmetic INSIDE test strings as the
  // literal text `$(( ... ))` — the wasm's native lowering handles the
  // clean scalar form (`x < x + 3`) but falls back to a string for the
  // dynamic-array form the sound generators use (`$(( tf_start[\$${tf_n}]
  // + tf_len[\$${tf_n}] ))`). The runtime expands the region BEFORE
  // tokenizing (it contains spaces, which would split it), substituting
  // like `arith`. The `$<digits>` prefixes are the emitter's
  // `\$`+value artifact (the interpolated VALUE with an escaped dollar
  // in front) — inside this arith context a bare `$<digits>` means that
  // literal value, so array subscripts read the element at that index.
  function evalTestArith(inner) {
    const sub = String(inner)
      .replace(/\$?\{?([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]\}?/g, (m, name, idx) => {
        const v = arithArrayIndex(name, idx);
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : "0";
      })
      .replace(/\$\{?([0-9][0-9]*)\}?/g, (m, n) => n)   // `$3` → 3 (the artifact)
      .replace(/\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
        const v = getVar(name);
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : "0";
      });
    return evalArithInt(sub);
  }

  function test(expr) {
    // Ctrl+C while a transpiled loop is spinning: abort it (the throw
    // escapes the try below — a swallowed false would just end the
    // loop and let the script limp on).
    if (interrupted) throw new Error("interrupted by Ctrl+C");
    try {
      // `${name+x}` — the "defined" marker (batch `if defined NAME`:
      // true even when set-but-empty, false when unset). The bracket
      // tokenizer can't express it, so handle it before parsing.
      const m = /^!?\$\{([A-Za-z_][A-Za-z0-9_]*)\+x\}$/.exec(String(expr));
      if (m) {
        const defined = vars.has(m[1]) || (env && env[m[1]] !== undefined);
        const r = m[0].startsWith("!") ? !defined : defined;
        lastStatus = r ? 0 : 1;
        return r;
      }
      // `$(( ... ))` inside the test — evaluate before tokenizing (it
      // contains spaces the bracket tokenizer would split)
      const expanded = String(expr).replace(/\$\(\(([\s\S]*?)\)\)/g, (mm, inner) => String(evalTestArith(inner)));
      const r = parseTest(tokenizeTest(expanded));
      // the estree's `(sh2.test(A), sh2.lastExit === 0 ? … : false)`
      // compositions rely on the test recording $? like bash — it never
      // did, so the second conjunct read a STALE lastExit (the sound
      // generators' note-scan "worked" for note 0 only by that accident).
      lastStatus = r ? 0 : 1;
      return r;
    } catch {
      lastStatus = 1;
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
    // the C NULL sentinel: a heap-pointer variable holds the string
    // "0" at the tail of a chain (the frontend seeds `p = 0`), so the
    // -n/-z pointer truthiness treats "0" as NULL (a live box is a
    // non-empty object/envelope, never the literal "0").
    if (op === "-z") { const sv = String(v); return sv.length === 0 || sv === "0"; }
    if (op === "-n") { const sv = String(v); return sv.length > 0 && sv !== "0"; }
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
    // The debashc lexer splits a for-in word on a `source.` basename
    // (the `source` KEYWORD): `/home/examples/source.bat` arrives as
    // ["/home/examples/", "source.bat"]. Re-join when the first part
    // ends with "/" (a path prefix) — the loop variable must be the
    // WHOLE path. Other word lists (`a b c`) pass through untouched.
    const list = items || [];
    const joined = (list.length > 1 && typeof list[0] === "string" && list[0].endsWith("/"))
      ? [list[0] + list.slice(1).map(String).join("")]
      : list;
    for (const it of joined) {
      if (interrupted) throw new Error("interrupted by Ctrl+C");
      try {
        await fn(it);
      } catch (e) {
        if (e instanceof LoopSignal && e.kind === "break") break;
        if (e instanceof LoopSignal && e.kind === "continue") continue;
        if (e instanceof ReturnSignal) throw e;
        throw e;
      }
      await maybeYield();
    }
  }

  // Sync twin of forLoop — the A1 lowers provably-sync for-in loops
  // (body await-free) to `sh2.forLoopSync(items, fn)` with NO per-item
  // promises. Same list-joining, break/continue LoopSignal contract.
  function forLoopSync(items, fn) {
    const list = items || [];
    const joined = (list.length > 1 && typeof list[0] === "string" && list[0].endsWith("/"))
      ? [list[0] + list.slice(1).map(String).join("")]
      : list;
    for (const it of joined) {
      if (interrupted) throw new Error("interrupted by Ctrl+C");
      try {
        fn(it);
      } catch (e) {
        if (e instanceof LoopSignal && e.kind === "break") break;
        if (e instanceof LoopSignal && e.kind === "continue") continue;
        if (e instanceof ReturnSignal) throw e;
        throw e;
      }
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
    // fast path: a plain numeric index (the game's per-cell reads pass
    // the computed idx or a raw "5") — skip the expansion machinery
    // entirely. `$var`-style keys still expand through the store.
    const i = typeof idx === "number"
      ? idx
      : Number(expandOperand(typeof idx === "string" ? idx : String(idx)));   // "$i" → value
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
  // ReturnSignal — a C `return V` inside a loop body (the transpiled
  // body is an arrow; a plain `return` would only exit the arrow and
  // the loop would spin forever). The estree pass rewrites in-loop
  // returns to `throw new sh2.ReturnSignal(V)`; the loop rethrows and
  // the fnCall/exec dispatch unwraps it back into the function's value.
  class ReturnSignal extends Error {
    constructor(value) {
      super("function return");
      this.value = value;
    }
  }
  function breakLoop() { throw new LoopSignal("break"); }
  function continueLoop() { throw new LoopSignal("continue"); }
  // `return N` inside a loop body — the estree emitter lowers it to
  // sh2.return(N): the arrow body can't `return` (it would only exit
  // the arrow and the loop would spin), so it throws a ReturnSignal
  // that whileLoop rethrows and exec unwraps as the function's value.
  function returnSignal(v) { throw new ReturnSignal(v); }

  // bash integer division / modulo (guarding /0 → 0)
  function idiv(a, b) { const n = Number(b); return n === 0 ? 0 : Math.trunc(Number(a) / n); }
  function imod(a, b) { const n = Number(b); return n === 0 ? 0 : Math.trunc(Number(a) % n); }

  // ! command / condition
  function not(v) { return !v; }

  // record $? after a condition
  function setLastExit(code) { lastStatus = Number(code); }

  async function whileLoop(cond, body) {
    while (await cond()) {
      if (interrupted) throw new Error("interrupted by Ctrl+C");
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
      if (interrupted) throw new Error("interrupted by Ctrl+C");
      try {
        body();
      } catch (e) {
        if (e instanceof LoopSignal && e.kind === "break") break;
        if (e instanceof LoopSignal && e.kind === "continue") continue;
        if (e instanceof ReturnSignal) throw e;
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

  // `cmd &` — the estree backend's background dispatch: run the body
  // DETACHED (fire-and-forget) so the transpiled `&` never blocks the
  // current chain (the game's sound pre-cache runs this way — the first
  // play of each bash sound is instant once the /tmp cache is warmed).
  // The shell's capture chain (capOut.__wraps) routes the task's output
  // to its OWN capture even while the main chain's commands run, so a
  // slow background command (a /bin/bash generator, ~20s for treasure)
  // doesn't steal the foreground's output. Errors are swallowed; $? = 0.
  function background(fn) {
    // ── `&` → WORKER THREAD or FORK? ───────────────────────────────
    // The heuristic (documented here so the generated code's choice is
    // traceable): a backgrounded `bash <script>` exec of an /examples
    // script (the texture/sound generators — self-contained pure
    // compute, no parent state) is routed to a JS WORKER THREAD via the
    // exec() hook, so the main event loop (a game's menu) never blocks
    // on generation. Everything else (shell functions, non-script
    // commands, simple subshells) FORKS — a detached task on the
    // current chain (bash's & semantics; the game's & usages are
    // fs-side work, so the shared-state approximation is faithful).
    if (/exec\("(?:\/bin\/)?bash"/.test(String(fn)) && /\/examples\//.test(String(fn))) {
      // WHY THREAD: the body execs a nested bash /examples script —
      // self-contained compute (only its args + stdout matter); the
      // worker runs it with a FRESH runtime (no parent state to copy),
      // and the result crosses back as this exec's stdout.
      if (env && env.SH2_BG_DEBUG) console.debug("[&] worker-thread: /examples bash script (pure compute) — main loop stays responsive");
      bgThreadJobs++;
      Promise.resolve().then(async () => {
        try { await fn(runtime.sh2); } catch {}
      }).finally(() => { bgThreadJobs--; });
      return true;
    }
    // WHY FORK: not a self-contained script exec — the body touches the
    // shell state (functions, vars) or is a plain command; run it
    // detached on the current chain (bash's &; a full copy-at-fork
    // clone of the shell state is the sh2loop v27 semantics — the
    // sh2runtime's state is closure-based, so the approximation stands
    // for the game's fs-side usages).
    if (env && env.SH2_BG_DEBUG) console.debug("[&] fork: non-script body (shell state / command) — detached on the current chain");
    Promise.resolve().then(async () => {
      try { await fn(runtime.sh2); } catch {}
    });
    return true;
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
  // Integer evaluator (bash semantics): substitutes variable names from
  // the store, then evaluates the expression with bash's operator
  // precedence and truncating / and %. The OLD implementation stripped
  // every char outside [0-9+-*/%().\s] — that removed `&` (so the phase
  // accumulators in the sound generators, `(a + b) & 65535`, evaluated
  // to a syntax error → 0 → silence) and compiled a fresh Function per
  // call (the treasure sound's ~30K arith calls each paid a JIT
  // compile). This version is a small shunting-yard evaluator: no
  // Function constructor, correct bitwise ops, integer division.
  //
  // Array subscripts come in BOTH emitter shapes: `${arr[$i]}` with the
  // index TEXT (shatter's `$(( ${SH_START[$sh_i]} … ))` — a live loop
  // var) and the `\$`+value ARTIFACT (treasure's `$(( tf_start[$3]
  // … ))` — the value with an escaped dollar in front). Resolve both:
  // a literal digit string is the index, a `$name` reads the store.
  function arithArrayIndex(name, idx) {
    const s = String(idx).trim();
    // the emitter's `\$`+value ARTIFACT (treasure's `tf_start[$3]`) and
    // plain literal indices → the digits are the index
    const dm = /^\$?\{?([0-9]+)\}?$/.exec(s);
    if (dm) return arrayIndex(name, dm[1]);
    // a live `$name` index (shatter's `${SH_START[$sh_i]}`) — keep the
    // `$` so arrayIndex's expandOperand reads the store
    const nm = /^\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(s);
    if (nm) return arrayIndex(name, "$" + nm[1]);
    return "0";
  }

  function arith(expr) {
    const substituted = String(expr)
      // `${arr[$i]}` / `$arr[$i]` — array ELEMENT reads: expand through
      // the store (the generated code passes the literal `${arr[$i]}`
      // text; the generic scalar rule below would match `$arr` and read
      // the whole array → NaN → 0 → the sound generators' phase/amp
      // accumulators silently became zero). Order matters: the array
      // form first, then scalars.
      .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]\}?/g, (m, name, idx) => {
        return arithArrayIndex(name, idx);
      })
      // `$1`..`$9` inside arithmetic — the callee's positionals (a
      // function body's `$(( $1 + $1 ))` must read its own args, not a
      // shell variable named "1"). The old char-stripping evaluator
      // happened to keep the DIGIT and evaluate `$1 + $1` as `1 + 1` —
      // wrong for every positional whose value isn't its own index.
      .replace(/\$\{?([1-9][0-9]*)\}?/g, (m, n) => {
        const v = scriptArgs[Number(n) - 1];
        const num = Number(v);
        return Number.isFinite(num) ? String(num) : "0";
      })
      .replace(/\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
        const v = getVar(name);
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : "0";
      });
    return evalArithInt(substituted);
  }

  // `listVar("@")` — the `$@` whole-word array form the estree backend
  // emits (core request array-flatten-positional-20260806): the array is
  // SPLICED into the callee's positionals by exec's arg flattener (bash
  // expands `"$@"` to separate args). `"*"` is the space-joined single
  // arg, `"#"` the count, `"0"` the script name.
  function listVar(spec) {
    if (spec === "@") return scriptArgs.slice();
    if (spec === "*") return [scriptArgs.join(" ")];
    if (spec === "#") return String(scriptArgs.length);
    if (spec === "0") return argv0;
    return "";
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
    // a lifted (module-`let`) var never writes its STORE copy, so the
    // strip forms (`${v#pat}` → sh2.param("#", "v", pat)) would read ""
    // — the paramLive pass appends the LIVE value as a 4th arg; use it
    // when the store is empty (the slice form already does this).
    const fallbackLive = (v, r) => (String(v) === "" && r.length > 1 ? r[1] : v);
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
      case "#": return trimByPattern(fallbackLive(val, rest), defaultVal, true, false);
      case "##": return trimByPattern(fallbackLive(val, rest), defaultVal, true, true);
      case "%": return trimByPattern(fallbackLive(val, rest), defaultVal, false, false);
      case "%%": return trimByPattern(fallbackLive(val, rest), defaultVal, false, true);
      case "slice": {
        const start = Number(expandOperand(String(rest[0]))) || 0;
        const len = rest.length > 1 ? Number(expandOperand(String(rest[1]))) : undefined;
        // an ARRAY variable — slice the elements (`${a[@]:s:l}`); a lone
        // element coerces to a string (the C `a[k]` read path).
        const raw = vars.has(name) ? vars.get(name) : (env && env[name] !== undefined ? env[name] : "");
        if (Array.isArray(raw)) {
          const elems = len === undefined ? raw.slice(start) : raw.slice(start, start + len);
          return elems.length === 1 ? String(elems[0]) : elems;
        }
        // a native PARAM's store copy is never written (the lift drops the
        // param-sync), so the emitter passes the live value as a 5th arg —
        // use it when the store is empty (draw_text's ${t:$i:1} sliced ""
        // and every canvas glyph fell to the blank-space mask).
        const str = String(raw);
        const src = str === "" && rest.length > 2 ? String(rest[2]) : str;
        return len === undefined ? src.slice(start) : src.slice(start, start + len);
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
  // memAdvance(h, delta) — a C pointer increment: return the pointer for
  // the element `delta` positions further on (`p + 1` / `p++`). A BOX
  // advances its element offset; an envelope re-encodes with the new
  // offset (the read-compat path).
  function memAdvance(h, delta) {
    const b = memBoxOf(h);
    if (b) return { ...b, off: (Number(b.off) || 0) + (Number(delta) || 0) };
    if (!/^\u0001mem:/.test(String(h))) h = memAddrOf(h);
    const m = /^\u0001mem:([^:]*):(-?\d+)$/.exec(String(h));
    if (!m) return String(h);
    return "\u0001mem:" + m[1] + ":" + (Number(m[2]) + (Number(delta) || 0));
  }
  const memArena = {};
  let memSeq = 0;
  function memAlloc(size, tag) {
    const n = Math.max(0, Math.floor(Number(size) || 0));
    const box = { arena: new Array(n).fill(0), size: n, tag: tag || null, off: 0, __id: ++memSeq };
    // the text seam (printf "%s", echo, $(…), env): a box serializes to
    // its legacy envelope `mem:<id>:<off>` — READ-ONLY compat; a
    // string is never the live pointer (memLoad re-resolves the id).
    box.toString = () => "\u0001mem:" + box.__id + ":" + (Number(box.off) || 0);
    memArena[box.__id] = box;
    return box;
  }
  // memBoxOf(h) — the box a pointer refers to: a BOX itself, or an
  // envelope (`\u0001mem:<id>:<off>`) whose numeric id maps into the
  // allocation registry. Named-var handles (slice 1) return null.
  function memBoxOf(h) {
    if (h && typeof h === "object" && Array.isArray(h.arena)) return h;
    const m = /^\u0001mem:([^:]+):(-?\d+)$/.exec(String(h));
    if (m && /^\d+$/.test(m[1])) {
      const box = memArena[Number(m[1])];
      if (box) return { ...box, off: Number(m[2]) || 0 };
    }
    return null;
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
  function memLoad(h, offset, type) {
    const b = memBoxOf(h);
    if (b) {
      // boxed heap pointer — DIRECT arena access: the byte index is
      // (box.off + element) * elemSize (the frontend passes the element
      // index; the struct-member lowering passes the byte offset with
      // elemSize "char" = 1). No parse, no registry lookup on the hot
      // path — the box already IS the allocation.
      const i = ((Number(b.off) || 0) + (Number(offset) || 0)) * memElemSize(type);
      // the cell may hold a scalar (string/number) OR another BOX (the
      // `p->next` chain) — return it as-is; a box stays a box.
      return i >= 0 && i < b.arena.length ? b.arena[i] : "";
    }
    // a bare variable name is a handle for its own element 0 (a pointer
    // IS a name — `sum_first a 3` and `sum_first "$(addr a)" 3` both
    // walk the array `a`); a slice-1 envelope reads the store element.
    if (!/^\u0001mem:/.test(String(h))) h = memAddrOf(h);
    return memLoad1(h);
  }
  function memStore(h, offset, type, v) {
    const b = memBoxOf(h);
    if (b) {
      const i = ((Number(b.off) || 0) + (Number(offset) || 0)) * memElemSize(type);
      if (i >= 0 && i < b.arena.length) b.arena[i] = (v && typeof v === "object") ? v : String(v ?? "");
      return;
    }
    if (!/^\u0001mem:/.test(String(h))) h = memAddrOf(h);
    memStore1(h, v);
  }
  function memFree(h) {
    const b = memBoxOf(h);
    if (b && b.__id && /^\d+$/.test(String(b.__id))) delete memArena[Number(b.__id)];
    else {
      const m = /^\u0001mem:([^:]+):(-?\d+)$/.exec(String(h));
      if (m && /^\d+$/.test(m[1])) delete memArena[Number(m[1])];
    }
  }
  // ─── the layout registry (registerStruct / nodeChild / nodeData) ───
  // registerStruct("Node-<hash>", [["word",0,"char"],["next",8,"ptr"]])
  // — the c-sh-go frontend emits it at source time for each `struct Tag`
  // it sees. `nodeChild(p, k)` / `nodeData(p, k)` resolve the tag →
  // layout → member (byte offset, elemSize), then read the member cell:
  // the generic-walker building blocks. Untagged allocations return "".
  const structLayouts = new Map();
  function registerStruct(tag, members) {
    structLayouts.set(String(tag), (members || []).map((m) => ({
      name: String(m[0]), offset: Number(m[1]) || 0, type: String(m[2] || "char"),
    })));
  }
  function nodeChild(p, k) {
    const b = memBoxOf(p);
    if (!b || !b.tag) return "";
    const layout = structLayouts.get(String(b.tag));
    const m = layout && layout[Number(k)];
    if (!m) return "";
    const i = ((Number(b.off) || 0) + m.offset);
    return i >= 0 && i < b.arena.length ? b.arena[i] : "";
  }
  function nodeData(p, k) {
    const b = memBoxOf(p);
    if (!b || !b.tag) return "";
    const layout = structLayouts.get(String(b.tag));
    const m = layout && layout[Number(k)];
    if (!m) return "";
    const i = ((Number(b.off) || 0) + m.offset);
    return i >= 0 && i < b.arena.length ? String(b.arena[i]) : "";
  }
  // a pointer's type tag — the frontend marks allocations with
  // memAlloc(size, "Tag-<hash>") when the C source has registerStruct.
  function ptrTag(p) {
    const b = memBoxOf(p);
    return b && b.tag ? String(b.tag) : "";
  }
  // ptrMembers(p) — the layout-registry member table of a tagged box:
  // [{ name, type, index }] — the ptrfs "directory listing". The shell
  // resolves each member's VALUE via nodeChild (box → directory,
  // scalar → file), so a pointer IS a tiny filesystem: cd into it,
  // find/ls walk it generically.
  function ptrMembers(p) {
    const b = memBoxOf(p);
    if (!b || !b.tag) return [];
    const layout = structLayouts.get(String(b.tag));
    if (!layout) return [];
    return layout.map((m, i) => ({ name: m.name, type: m.type, index: i }));
  }

  const runtime = {
    sh2: {
      exec, pipeline, capture, captureSync, pipelineSync, captureWords, redirect, test,
      forLoop, forLoopSync, whileLoop, whileLoopSync, caseMatch, define, brace, param, arith, fparith,
      guard, and, or, arithEval, background,
      setArray, setArrayAppend, arrayIndex, arrayLen, arrayItems, join,
      strcmp,
      readLine,
      // sh2.stdin — the shell seeds the current pipe input before each
      // transpiled program; the c frontend's read_line() consumes it.
      set stdin(v) { stdinData = String(v ?? ""); stdinPos = 0; stdinAtEOF = false; },
      get stdin() { return stdinData; },
      getLine,
      getLineD: getLine,
      memAddrOf: memAddrOf, memLoad, memStore, memAlloc, memElemSize, memFree, memAdvance, memBoxOf,
      registerStruct, nodeChild, nodeData, ptrTag, ptrMembers,
      assign,
      "break": breakLoop, "continue": continueLoop, "return": returnSignal,
      ReturnSignal,
      idiv, imod, not, setLastExit,
      getVar, setVar, listVar,
      // the otranspilerl estree backend reads/writes sh2.lastExit
      get lastExit() { return lastStatus; },
      set lastExit(v) { lastStatus = Number(v); },
      // $1..$9 / $@ — the native estree reads sh2.positional
      get positional() { return scriptArgs; },
      set positional(v) { scriptArgs = Array.isArray(v) ? v.map(String) : []; },
      // the shell env — the generated estree's `process.env.X ?? ""`
      // fallbacks are rewritten to `sh2.env.X` (no `process` reference,
      // so a scope without a process global can't throw)
      get env() { return env || {}; },
      // $0 / the script name (sh2.argv0 — settable so `bash script.sh`
      // and `set --` can change it per line)
      get argv0() { return argv0; },
      set argv0(v) { argv0 = String(v ?? "bash"); },
      // the native store the otranspilerl estree backend reads/writes
      // (`sh2.vars.x` — see sh2perl/src/estree.rs native-store fold;
      // generated code adds the env fallback itself as
      // `sh2.vars.x ?? (process.env.x ?? "")` — but `process` is not a
      // global in every scope the functions can run from (a sourced C
      // function called later throws "process is not defined"), so the
      // proxy resolves the env fallback HERE: a Map miss reads the shell
      // env (else "") and is never nullish, making the generated
      // `?? (process.env.x ?? "")` dead code — same semantics, no
      // `process` reference.
      vars: new Proxy(Object.create(null), {
        get: (t, k) => {
          if (typeof k !== "string") return undefined;
          if (vars.has(k)) return vars.get(k);
          if (env && env[k] !== undefined) return env[k];
          return "";
        },
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
        // `>> file` (the otranspilerl estree lowers append redirects to
        // this): read the existing content and write it back with the
        // new data appended.
        appendFile: async (p, data) => {
          let existing = "";
          try { existing = String(await fs.read(p) ?? ""); } catch {}
          await fs.write(p, existing + String(data ?? ""));
        },
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
        // flatten nested arrays — the debashl renders brace expansion
        // ({a,b}.c) as [["a.c","b.c"]] and a nested array must become
        // separate args, not one "a.c,b.c" string
        const a = flattenArgs(argsArr || []);
        switch (name) {
          case "echo": return a.join(" ") + "\n";
          case "printf": {
            // the bash printf builtin: FORMAT [ARGS…]. The estree backend
            // passes the format as args[0] (the sound generators' final
            // `printf "%b" "$tsv"`, the WAV path's `printf -v oc '%03o'
            // $n`). The OLD code concatenated ALL args — the format string
            // leaked into the output ("%b0\t0\t…"). Minimal conversion
            // set: %b (escape-interpret), %s, %d/%i/%u, %o/%x/%X, %c,
            // %%, with a 0-flag + width pad.
            const outFmt = (format, vals) => {
              let r = "";
              let i = 0, v = 0;
              const s = String(format);
              const next = () => (v < vals.length ? String(vals[v++]) : "");
              const unesc = (x) => String(x).replace(/\\n/g, "\n").replace(/\\t/g, "\t")
                .replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
              while (i < s.length) {
                if (s[i] !== "%") { r += s[i++]; continue; }
                i++;
                if (i < s.length && s[i] === "%") { r += "%"; i++; continue; }
                let zero = false, pad = 0;
                while (i < s.length && "0-+ #".includes(s[i])) { if (s[i] === "0") zero = true; i++; }
                while (i < s.length && s[i] >= "0" && s[i] <= "9") { pad = pad * 10 + (s[i].charCodeAt(0) - 48); i++; }
                if (i >= s.length) break;
                const conv = s[i++];
                const val = next();
                let piece;
                switch (conv) {
                  case "b": piece = unesc(val); break;
                  case "s": piece = String(val); break;
                  case "d": case "i": case "u": piece = String(Math.trunc(Number(val) || 0)); break;
                  case "o": piece = (Math.trunc(Number(val) || 0) >>> 0).toString(8); break;
                  case "x": piece = (Math.trunc(Number(val) || 0) >>> 0).toString(16); break;
                  case "X": piece = (Math.trunc(Number(val) || 0) >>> 0).toString(16).toUpperCase(); break;
                  case "c": piece = String(val).charAt(0); break;
                  default: piece = "";
                }
                if (pad > piece.length && zero) piece = piece.padStart(pad, "0");
                else if (pad > piece.length) piece = piece.padStart(pad, " ");
                r += piece;
              }
              // bash interprets backslash escapes in the FORMAT's literal
              // text too (printf 'a\\nb' prints a newline) — %b means the
              // ARG's escapes get the same treatment.
              return unesc(r);
            };
            // printf -v NAME FORMAT [ARGS…] — assign the formatted result
            // to the shell variable (the WAV path's octal byte builder)
            if (a[0] === "-v") {
              const name = String(a[1] ?? "");
              setVar(name, outFmt(a[2] ?? "%s", a.slice(3)));
              return "";
            }
            return outFmt(a[0] ?? "%s", a.slice(1));
          }
          case "true": return "";
          case "false": return "";
          case "date": return new Date().toString() + "\n";
          case "pwd": return ((fs.cwd !== undefined ? fs.cwd : "/") || "/") + "\n";
          case "cat": {
            // SYNC cat for sourced function bodies (the emitter renders
            // `cat file > device` through sh2.builtin). Read via the fs
            // sync bridge (local mounts); remote/device paths without a
            // sync backend answer "" — the async exec path covers those.
            let out = "";
            for (const p of a) {
              if (p === "-") { out += stdinData; continue; }
              try {
                const r = fs.readSync ? fs.readSync(p) : null;
                if (r === null || r === undefined) continue;
                // readSync returns Uint8Array on the local mounts — a
                // raw String() would comma-join the byte codes; decode
                out += typeof r === "string" ? r : new TextDecoder().decode(r);
              } catch { /* ENOENT → empty */ }
            }
            return out;
          }
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
            } else if (op === "-n") r = operand.length > 0 && operand !== "0";
            else if (op === "-z") r = operand.length === 0 || operand === "0";
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
      redirectSync(fn, redirects) {
        // fd-dup targets (`>&2` → target "&2") are SYNCHRONOUS — the
        // content routes straight to the fd's sink. File targets are only
        // safe here when the mounted backend exposes writeSync; the
        // ESTree safety pass normally rewrites them to redirect().
        const buf = { out: "", err: "" };
        const prevMode = mode;
        const stdoutObj = stdout;
        const stderrObj = stderr;
        const hostOut = typeof globalThis !== "undefined" && globalThis.process && globalThis.process.stdout;
        const hostErr = typeof globalThis !== "undefined" && globalThis.process && globalThis.process.stderr;
        const outObjs = [stdoutObj, hostOut].filter((x, i, a) => x && typeof x.write === "function" && a.indexOf(x) === i);
        const errObjs = [stderrObj, hostErr].filter((x, i, a) => x && typeof x.write === "function" && a.indexOf(x) === i);
        const origOuts = outObjs.map((x) => x.write);
        const origErrs = errObjs.map((x) => x.write);
        outObjs.forEach((x) => { x.write = (s) => { buf.out += String(s); return true; }; });
        errObjs.forEach((x) => { x.write = (s) => { buf.err += String(s); return true; }; });
        mode = { type: "redirect", buf };
        let ret;
        try {
          ret = fn();
        } finally {
          outObjs.forEach((x, i) => { x.write = origOuts[i]; });
          errObjs.forEach((x, i) => { x.write = origErrs[i]; });
          mode = prevMode;
        }
        for (const r of redirects || []) {
          const fd = r.fd || 1;
          const target = String(r.target || "");
          // `/dev/null` — discard, the universal no-op (a sync builtin's
          // `2>/dev/null` must not trip the file-target bridge)
          if (target === "/dev/null") {
            continue;
          }
          if (!target.startsWith("&")) {
            // FILE target: the fs backends (RamFS/LocalStorageFS/device
            // mounts) write synchronously under the hood — route the
            // sync builtin's content the same way the async redirect
            // bridge does (`>>` appends). The game's load_tex cache
            // read (`cat /home/... > /dev/webgl/texture/N`) lands here
            // on the cache-hit path.
            const content = typeof ret === "string" ? ret : (fd === 2 ? buf.err : buf.out);
            if (typeof fs.writeSync !== "function") {
              throw new Error("redirectSync: file target requires async redirect");
            }
            if (r.mode === "a") {
              let existing = "";
              try {
                const prior = fs.readSync ? fs.readSync(target) : null;
                existing = typeof prior === "string" ? prior : prior ? new TextDecoder().decode(prior) : "";
              } catch { /* new file */ }
              if (!fs.writeSync(target, existing + content)) {
                throw new Error("redirectSync: file target requires async redirect");
              }
            } else if (!fs.writeSync(target, content)) {
              throw new Error("redirectSync: file target requires async redirect");
            }
            continue;
          }
          // the sync builtin returns its output string (echo/printf);
          // fall back to the mode buffer for other writers
          const content = typeof ret === "string" ? ret : (fd === 2 ? buf.err : buf.out);
          const tfd = Number(target.slice(1));
          if (tfd === 1) { if (content) stdout.write(content); }
          else if (tfd === 2) { if (content) stderr.write(content); }
          else throw new Error(`redirect: no fd ${tfd}`);
        }
        return ret;
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
        // splice array args (the `$@` listVar contract — exec does the
        // same): a nested array becomes separate positionals, not one
        // comma-joined string (`show "$@"` would otherwise see a single
        // "a,b,c" positional and $# = 1).
        scriptArgs = (() => {
          const flat = [];
          for (const a of argsArr || []) {
            if (Array.isArray(a)) {
              for (const x of a) flat.push((x && typeof x === "object" && Array.isArray(x.arena)) ? x : String(x));
            } else {
              flat.push((a && typeof a === "object" && Array.isArray(a.arena)) ? a : String(a));
            }
          }
          return flat;
        })();
        let r;
        try {
          r = fn();
        } catch (e) {
          scriptArgs = prev;
          if (e instanceof ReturnSignal) return e.value;
          throw e;
        }
        if (r && typeof r.then === "function") {
          return r.then(
            (v) => {
              scriptArgs = prev;
              lastStatus = (typeof v === "string" || typeof v === "number") ? Number(v) : (v === false ? 1 : 0);
              return v;
            },
            // an ASYNC target's `return N` rejects with ReturnSignal —
            // swallow it here like the sync path's try/catch does, or it
            // would leak into the CALLER's dispatch and abort it (exec
            // would treat the callee's return as the caller's own).
            (e) => {
              scriptArgs = prev;
              if (e instanceof ReturnSignal) { lastStatus = Number(e.value); return e.value; }
              throw e;
            }
          );
        }
        scriptArgs = prev;
        // `return N` gives a string/number result — record it as $? like
        // the exec dispatch does; booleans are the status verdicts.
        lastStatus = (typeof r === "string" || typeof r === "number") ? Number(r) : (r === false ? 1 : 0);
        return r;
      },
      // `f …` — invoke a DIRECT-registered function body (the estree's
      // native-direct subset); same sync-capable contract as fnCall.
      callDirect(name, fn, argsArr) {
        if (typeof fn !== "function") throw new Error("sh2.callDirect: no function '" + name + "'");
        const prev = scriptArgs;
        // same nested-array splice as fnCall/exec (the `$@` listVar contract)
        scriptArgs = (() => {
          const flat = [];
          for (const a of argsArr || []) {
            if (Array.isArray(a)) {
              for (const x of a) flat.push((x && typeof x === "object" && Array.isArray(x.arena)) ? x : String(x));
            } else {
              flat.push((a && typeof a === "object" && Array.isArray(a.arena)) ? a : String(a));
            }
          }
          return flat;
        })();
        let r;
        try {
          r = fn();
        } catch (e) {
          scriptArgs = prev;
          if (e instanceof ReturnSignal) return e.value;
          throw e;
        }
        if (r && typeof r.then === "function") {
          return r.then(
            (v) => {
              scriptArgs = prev;
              lastStatus = (typeof v === "string" || typeof v === "number") ? Number(v) : (v === false ? 1 : 0);
              return v;
            },
            // an ASYNC target's `return N` rejects with ReturnSignal —
            // swallow it here like the sync path's try/catch does, or it
            // would leak into the CALLER's dispatch and abort it (exec
            // would treat the callee's return as the caller's own).
            (e) => {
              scriptArgs = prev;
              if (e instanceof ReturnSignal) { lastStatus = Number(e.value); return e.value; }
              throw e;
            }
          );
        }
        scriptArgs = prev;
        // `return N` gives a string/number result — record it as $? like
        // the exec dispatch does; booleans are the status verdicts.
        lastStatus = (typeof r === "string" || typeof r === "number") ? Number(r) : (r === false ? 1 : 0);
        return r;
      },
    },
    get lastStatus() { return lastStatus; },
  };
  return runtime;
}
