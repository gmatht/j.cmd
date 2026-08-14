// ─── shellcore/transpile.js — SHARED transpiler helpers ─────────
// The stateless pieces of the persistent-transpile machinery both
// shells duplicate. The STATE (otRt, otVars) stays per-shell — it is
// execution state the line handlers weave through — but these helpers
// are pure / state-passed, so there is one implementation.
import { fs } from "../fs/index.js";
import { env, isReadonly, getShellStatus, setShellStatus, getPositional, setPositional, getArgv0 } from "../env.js";

export function a1LiteralValue(expr) {
  if (!expr) return undefined;
  if (expr.type === "Str") return String(expr.value ?? "");
  if (expr.type === "Num" || expr.type === "Bool") return String(expr.value ?? "");
  // Arith: `set /a X=2+3` — the bat-sh-go frontend emits constant
  // arithmetic as {type:"Arith", ast:{Bin …}}; evaluate it statically so
  // the value survives the harvest (the $(( )) render hoists a let).
  if (expr.type === "Arith" && expr.ast) {
    const evalBin = (n) => {
      if (!n) return undefined;
      if (n.type === "Num") return Number(n.value);
      if (n.type === "Bin") {
        const l = evalBin(n.lhs), r = evalBin(n.rhs);
        if (l === undefined || r === undefined) return undefined;
        switch (n.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return l / r;
          case "%": return l % r;
        }
        return undefined;
      }
      return undefined;   // a %var% operand — can't resolve statically
    };
    const v = evalBin(expr.ast);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return undefined;
  }
  if (expr.type === "Interpolate" && Array.isArray(expr.parts)) {
    // concatenate literal parts + statically resolvable getVar parts
    // (`DEVDIR=$HOME/dev` — the eval hoists a `let DEVDIR`, invisible
    // to the runtime diff, so resolve it here from env/otVars)
    let out = "";
    for (const p of expr.parts) {
      if (p && p.kind === "lit") { out += String(p.text ?? ""); continue; }
      if (p && p.kind === "expr" && p.expr && p.expr.type === "Call" &&
          p.expr.func === "getVar" && p.expr.args && p.expr.args[0] && p.expr.args[0].type === "Str") {
        const name = p.expr.args[0].value;
        if (otVars.has(name)) out += Array.isArray(otVars.get(name)) ? otVars.get(name).join(" ") : String(otVars.get(name));
        else if (env[name] !== undefined) out += String(env[name]);
        else out += "";
        continue;
      }
      return undefined;   // computed part we can't resolve statically
    }
    return out;
  }
  if (expr.type === "Call" && expr.func === "setArray" &&
      expr.args && expr.args[1] && expr.args[1].type === "Array") {
    const out = [];
    for (const el of expr.args[1].elements || []) {
      if (el && el.type === "Str") out.push(String(el.value ?? ""));
      else return undefined;
    }
    return out;
  }
  return undefined;
}

// Mirror the persistent runtime's store back into otVars after a NATIVE
// command that mutated it through sh2 (e.g. a sourced C function sorted
// an array in place). `otRt`/`otVars` are passed in — each shell owns
// its instances.
export function syncOtVarsFromStore(otRt, otVars) {
  if (!otRt || !otRt.sh2 || !otRt.sh2.vars) return;
  const keepable = (val) => typeof val === "string" || typeof val === "number" || Array.isArray(val);
  for (const k of Object.keys(otRt.sh2.vars)) {
    const val = otRt.sh2.vars[k];
    if (!keepable(val) || k.startsWith("__")) continue;
    if (isReadonly(k)) continue;
    otVars.set(k, Array.isArray(val) ? val : String(val));
  }
  // mirror into the shell's env too — a NATIVE line after the call
  // (`echo "a=($a)"`) expands $NAME from env, which the transpiled
  // runEstreeProgram mirror normally refreshes; a native fnCall
  // dispatch (findCommand → sh2.fnCall) must do the same or it sees
  // the stale pre-call value.
  for (const [k, v] of otVars) {
    if (isReadonly(k)) continue;
    try { env[k] = Array.isArray(v) ? v.join(" ") : String(v); } catch {}
  }
}

// ─── runSourceContent: source a transpiled file in the current shell ──
// SHARED by the CLI and the browser shell (the `source` / `.` builtin in
// shellcore/builtins.js dispatches here via ctx.runSourceContent). The
// frontend work is common: sh/zsh → shir; everything else → the unified
// busybox frontend; then the A1 literal harvest. The final program eval
// differs per shell (the CLI's runEstreeProgram vs the browser's
// evalOnOtRt), so the shell passes ctx.evalProgram.
//
// ctx: { runJsSourceContent, getOtVars, fetchBusyboxBytes, goRunner,
//        goCmd, evalProgram(program, lineAssigned, srcArgs) }
export async function runSourceContent(content, lang, srcArgs, ctx) {
  if (lang === "js") return await ctx.runJsSourceContent(content, srcArgs);
  const { getOtranspilerl } = await import("../otranspilerl.js");
  const lib = await getOtranspilerl();
  const otVars = ctx.getOtVars();
  let a1;
  if (lang === "sh" || lang === "zsh") {
    // Seed the shell's known variables so $x reads compile live — the
    // same seeding the line fallback does.
    const seed = [...otVars].map(([k, v]) =>
      Array.isArray(v)
        ? `${k}=(${v.map((x) => JSON.stringify(String(x))).join(" ")});`
        : `${k}=${JSON.stringify(String(v))};`
    ).join("");
    a1 = JSON.parse(lib.shir(seed + String(content)));
  } else {
    if (lang === "cpp" || lang === "powershell" || lang === "rust" || lang === "zig") {
      // These frontends exist in the sh2loop fleet (cpp-sh-go /
      // powershell-sh-go / rust-frontend / zig-sh-go) but are not in
      // the browser busybox (tree-sitter cgo / a Rust binary).
      throw new Error(lang + " frontend not ported to the browser wasm yet — " +
        "run it in the sh2loop fleet to transpile");
    }
    const { ensureBusyboxWasm, busyboxA1 } = await import("../busybox.js");
    const wasmPath = await ensureBusyboxWasm(fs, {
      goRunner: ctx.goRunner, goCmd: ctx.goCmd, fetchBytes: ctx.fetchBusyboxBytes,
    });
    a1 = await busyboxA1(String(content), lang, { fs, wasmPath, goRunner: ctx.goRunner });
    // the otranspilerl renderer panics on Goto/Label — refuse loudly up
    // front (REFUSE > GUESS) instead of crashing
    if (a1 && Array.isArray(a1.stmts)) {
      for (const st of a1.stmts) {
        if (st && (st.type === "Goto" || st.type === "Label")) {
          throw new Error("goto/labels are not supported by the jtsh renderer yet (the debashc verify pipeline can render them)");
        }
      }
    }
  }
  const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
  // A1 literal harvest: deterministic assignment values (Str/Num/Bool/
  // all-lit Interpolate/setArray) — pre-seeds otVars so a sourced
  // `int counter = 42` shows up as $counter even though the generated
  // `let counter = 42` is eval-scoped (invisible to the runtime diff).
  const lineAssigned = new Set();
  try {
    for (const st of (a1 && a1.stmts) || []) {
      if (st && st.type === "Assign" && st.targets && st.targets[0]) {
        const t = st.targets[0];
        if (t.var && !(t.indices && t.indices.length)) {
          lineAssigned.add(t.var);
          const val = a1LiteralValue(st.expr);
          if (val !== undefined) otVars.set(t.var, val);
        }
      }
    }
  } catch {}
  return await ctx.evalProgram(program, lineAssigned, srcArgs);
}

// ─── evalProgramOnOtRt: eval generated JS on the persistent runtime ──
// The eval + state-harvest block both shells duplicated (the CLI's
// runEstreeProgram tail and the browser's evalOnOtRt were ~90 lines of
// the same code). Shared here; the shell passes a ctx with the state
// accessors: { ensureOtRuntime, getOtRt, getOtVars, stdinBuffer, otProc }.
//
// opts: { lineAssigned, lineCaptured, sourcePositional, positional }
//   sourcePositional — a sourced script's own $@ (restore the caller's
//     afterwards); positional — a plain line's $1..$9 (else the caller's).
export async function evalProgramOnOtRt(js, opts, ctx) {
  const { lineAssigned = new Set(), lineCaptured = new Set(), sourcePositional = null, positional = null } = opts || {};
  await ctx.ensureOtRuntime();
  const otRt = typeof ctx.getOtRt === "function" ? ctx.getOtRt() : ctx.otRt;
  const otVars = typeof ctx.getOtVars === "function" ? ctx.getOtVars() : ctx.otVars;
  const fn = new Function("fs", "env", "process", "sh2", `
    return (async () => { ${js} })();
  `);
  // pre-seed the runtime store so native-store reads (sh2.vars.x,
  // sh2.arrayIndex / sh2.arrayLen) see the persistent state. Arrays go
  // through sh2.setArray — `sh2.vars.a = …` would stringify them.
  // preseedVars records what we planted, so the post-eval diff can tell
  // a line's OWN write (value changed) from untouched pre-seed state.
  const preseedVars = new Map();
  for (const [k, v] of otVars) {
    try {
      if (Array.isArray(v)) { otRt.sh2.setArray(k, v); preseedVars.set(k, v); }
      else { otRt.sh2.vars[k] = v; preseedVars.set(k, String(v)); }
    } catch {}
  }
  try { otRt.sh2.lastExit = getShellStatus(); } catch {}   // native $? → transpiled
  const sb = typeof ctx.stdinBuffer === "function" ? ctx.stdinBuffer() : ctx.stdinBuffer;
  try { otRt.sh2.stdin = sb || ""; } catch {}   // pipe input → read_line()
  const savedPositional = getPositional();                  // the caller's $1..$9
  const savedArgv0 = getArgv0();                            // the caller's $0
  try {
    if (sourcePositional) { otRt.sh2.positional = sourcePositional.args; otRt.sh2.argv0 = sourcePositional.argv0; }
    else if (positional && positional.length) { otRt.sh2.positional = positional; }
    else { otRt.sh2.positional = savedPositional; otRt.sh2.argv0 = savedArgv0; }
  } catch {}
  let v;
  let exitCode = null;
  const beforeGlobals = new Set(Object.keys(globalThis));
  const beforeRtVars = new Set(Object.keys(otRt.sh2.vars));
  try {
    v = await fn(fs, env, ctx.otProc(), otRt.sh2);
  } catch (e) {
    if (e && e.exitCode !== undefined) exitCode = e.exitCode;  // `exit N`
    else throw e;
  }
  // Introspection: harvest the variables this line set. Bare assignments
  // (`x = 5`) became implicit globals (sloppy function scope); the
  // `sh2.vars.* = …` writes went into the runtime's map. Strings,
  // numbers and arrays are shell data — functions and other objects
  // (the emitter's `__fn_*` closures) are skipped and dropped, keeping
  // the page global scope clean.
  const keepable = (val) => typeof val === "string" || typeof val === "number" || Array.isArray(val);
  const sameValue = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
    }
    return String(a) === String(b);
  };
  // runtime store first: it holds the line's OWN writes (sh2.setVar /
  // sh2.setArray — the scalar re-assignment of an array name lands here,
  // not on globalThis). Skip untouched state: a pre-seeded name this
  // line didn't assign, OR whose value is still exactly the pre-seed
  // (the line's write went elsewhere — a bare `x = …` lands on
  // globalThis, which the next loop captures).
  for (const k of Object.keys(otRt.sh2.vars)) {
    const val = otRt.sh2.vars[k];
    if (!keepable(val) || k.startsWith("__")) continue;
    if (beforeRtVars.has(k) && !lineAssigned.has(k)) continue;
    if (preseedVars.has(k) && sameValue(preseedVars.get(k), val)) continue;
    if (isReadonly(k)) continue;   // setVar refuses these anyway
    otVars.set(k, Array.isArray(val) ? val : String(val));
    lineCaptured.add(k);
  }
  // globalThis last: bare assignments land here — but so does the seed's
  // own `a = [...]` leftover, which is STALE when the line re-assigned
  // via setVar/setArray or a literal. Names already captured this line
  // are not overridden; everything else is harvested and cleaned up.
  for (const k of Object.keys(globalThis)) {
    if (beforeGlobals.has(k)) continue;
    const val = globalThis[k];
    if (!lineCaptured.has(k) && keepable(val) && !k.startsWith("__")) {
      otVars.set(k, Array.isArray(val) ? val : String(val));
      lineCaptured.add(k);
    }
    try { delete globalThis[k]; } catch {}   // ALWAYS clean up — even when the A1
                                             // already captured the value, the
                                             // global must not linger (it would
                                             // shadow the next line's re-assign)
  }
  // mirror the persistent state into the shell's env so NATIVE lines
  // (`echo $a` without bash syntax) see transpiled variables too — the
  // native tokenizer expands $NAME from the shared env object. Readonly
  // names are skipped (never overwrite them).
  for (const [k, v] of otVars) {
    if (isReadonly(k)) continue;
    try { env[k] = Array.isArray(v) ? v.join(" ") : String(v); } catch {}
  }
  // positional: a sourced script's $@ is its own (restore the caller's);
  // a plain transpiled line round-trips native → runtime → native so
  // `set --` still lands.
  try { setPositional(sourcePositional ? savedPositional : otRt.sh2.positional,
                     sourcePositional ? savedArgv0 : otRt.sh2.argv0); } catch {}
  if (exitCode !== null) { setShellStatus(exitCode); return exitCode; }  // `exit N`
  // The estree convention: each statement's value is the command's
  // success flag (true/false) — assignments carry their value but exit 0.
  // A bare C-function call (`sum_first "$(addr a)" 3`) runs through
  // sh2.exec, whose boolean masks the C return value — the runtime
  // already records it as sh2.lastExit (`return 60` → 60), so a failing
  // (non-zero) call reports the C return as $?, like the docs say.
  const exitVal = v === false ? (Number(otRt.sh2.lastExit) || 1) : 0;
  setShellStatus(exitVal);   // transpiled $? → native
  return exitVal;
}

// ─── transpileLine: the bash-line fallback (runViaTranspiler) ───────
// SHARED: transpile a bash line to JS and run it on the persistent
// runtime. Seeds the known variables so $x reads compile live, then
// delegates the eval to ctx.evalProgram (the per-shell program eval
// wrapper — CLI runEstreeProgram / browser evalOnOtRt).
export async function transpileLine(segmentText, ctx) {
  const { getOtranspilerl } = await import("../otranspilerl.js");
  const lib = await getOtranspilerl();
  const otVars = ctx.getOtVars();
  // Seed: declare the known variables in-program so $x reads compile
  // live instead of folding to "". Scalars seed as `k="v";`; arrays as
  // `k=("a" "b");` so debashl emits a real array declaration.
  const seed = [...otVars].map(([k, v]) =>
    Array.isArray(v)
      ? `${k}=(${v.map((x) => JSON.stringify(String(x))).join(" ")});`
      : `${k}=${JSON.stringify(String(v))};`
  ).join("");
  const src = seed + segmentText;
  const program = JSON.parse(lib.transpile(src, "sh", "js"));
  // A1 harvest: deterministic assignment values — catches dead-stored
  // arrays (`a=(1 2 3);` alone emits no JS at all) that never reach the
  // runtime diffs below.
  const lineAssigned = new Set();   // names this line's A1 says were assigned
  try {
    const a1 = JSON.parse(lib.shir(src));
    for (const st of a1.stmts || []) {
      if (st && st.type === "Assign" && st.targets && st.targets[0]) {
        const t = st.targets[0];
        if (t.var && !(t.indices && t.indices.length)) {
          lineAssigned.add(t.var);
          const val = a1LiteralValue(st.expr);
          if (val !== undefined) otVars.set(t.var, val);
        }
      }
    }
  } catch {}
  return ctx.evalProgram(program, lineAssigned, []);
}

// ─── ensureOtRuntime: build the persistent runtime + process shim ───
// SHARED by both shells. ctx: { stdoutWrite, stderrWrite, shellExec,
//   setOtRt, setOtProc } — the per-shell bits are the output writers,
// the nested-command bridge, and where otRt/otProc live.
export async function ensureOtRuntime(ctx) {
  const existing = typeof ctx.getOtRt === "function" ? ctx.getOtRt() : ctx.otRt;
  if (existing) return existing;
  const { createSh2Runtime } = await import("../sh2runtime.js");
  // The native estree backend writes through process.stdout.write and
  // reads process.env/argv — provide a shim (in the browser there is no
  // node process at all).
  const writeOut = ctx.stdoutWrite;
  const writeErr = ctx.stderrWrite;
  const out = { write: (s) => { if (s) writeOut(s); } };
  const err = { write: (s) => { if (s) writeErr(s); } };
  const otProc = {
    stdout: out,
    stderr: err,
    pid: 1,
    argv: ["jtsh"],
    env: env || {},
    cwd: () => (fs.cwd !== undefined ? fs.cwd : "/"),
    // `exit N` in the generated JS — must NOT kill the shell.
    exit(code) {
      const e = new Error("__otranspiler_exit__" + code);
      e.exitCode = Number(code) || 0;
      throw e;
    },
    // `cd DIR` / `pwd` — the native estree drives cwd through process
    chdir(p) {
      if (fs && fs.cwd !== undefined) {
        fs.cwd = String(p).replace(/\/+$/, "") || "/";
        try { env.PWD = fs.cwd; } catch {}   // keep $PWD honest for native lines
      }
    },
    cwd() { return (fs.cwd !== undefined ? fs.cwd : "/") || "/"; },
  };
  const otRt = createSh2Runtime({
    fs, env, shellExec: ctx.shellExec || ctx.runNestedCommand,
    stdout: out, stderr: err, args: [], argv0: "sh",
  });
  ctx.setOtRt(otRt);
  ctx.setOtProc(otProc);
  return otRt;
}

// ─── runShellScript: transpile + run a bash SCRIPT on a fresh runtime ──
// SHARED by both shells. A bash script (`bash script.sh`, `. file.sh`,
// a shebang run) executes in an ISOLATED runtime — its own $@/$0/exit
// status — deliberately NOT the persistent otRt (the script's internals
// must not leak into the interactive shell's state). The transpiler,
// array restore and eval are one copy here; ctx supplies the output
// writers and the nested-command bridge.
//   opts: { args, argv0, runCmd } — runCmd defaults to ctx.runNestedCommand
export async function runShellScript(content, opts = {}, ctx) {
  const { args = [], argv0 = "script", runCmd = null } = opts;
  const { getOtranspilerl } = await import("../otranspilerl.js");
  const lib = await getOtranspilerl();
  const { estreeToJs, keepVariables } = await import("../estree.js");
  const program = JSON.parse(lib.transpile(String(content), "sh", "js"));
  // Restore dead-stored arrays: debashl drops the `arr=(…)` assignment
  // when the reads are bare (`arr.length`, `arr[1]`), so the A1's literal
  // values are pre-seeded into the fresh runtime and the reads are
  // rewritten to arrayIndex/arrayLen (keepVariables).
  const scriptArrays = [];
  const arrayVals = new Map();
  try {
    const a1 = JSON.parse(lib.shir(String(content)));
    for (const st of a1.stmts || []) {
      if (st && st.type === "Assign" && st.targets && st.targets[0]) {
        const t = st.targets[0];
        if (t.var && !(t.indices && t.indices.length)) {
          const val = a1LiteralValue(st.expr);
          if (Array.isArray(val)) { scriptArrays.push(t.var); arrayVals.set(t.var, val); }
        }
      }
    }
  } catch {}
  keepVariables(program, scriptArrays);
  const body = program.body || [];
  const last = body[body.length - 1];
  const lastIsExpr = last && last.type === "ExpressionStatement";
  const bodyJs = (lastIsExpr
    ? (body.length > 1 ? await estreeToJs({ type: "Program", body: body.slice(0, -1) }) : "")
    : await estreeToJs({ type: "Program", body })) + "\n";
  const lastJs = lastIsExpr
    ? "return (" + (await estreeToJs({ type: "Program", body: [last] })).replace(/;\s*$/, "") + ");\n"
    : "return sh2.lastExit;\n";
  const js = bodyJs + lastJs;
  const { createSh2Runtime } = await import("../sh2runtime.js");
  const out = { write: (s) => { if (s) ctx.stdoutWrite(s); } };
  const err = { write: (s) => { if (s) ctx.stderrWrite(s); } };
  const rt = createSh2Runtime({ fs, env, shellExec: runCmd || ctx.runNestedCommand, stdout: out, stderr: err, args, argv0 });
  for (const [name, vals] of arrayVals) { try { rt.sh2.setArray(name, vals); } catch {} }
  const proc = {
    stdout: out, stderr: err, pid: 1,
    argv: [argv0, ...args],
    env: env || {},
    cwd: () => (fs.cwd !== undefined ? fs.cwd : "/"),
    exit(code) { const e = new Error("__otranspiler_exit__" + code); e.exitCode = Number(code) || 0; throw e; },
    chdir(p) {
      if (fs && fs.cwd !== undefined) {
        fs.cwd = String(p).replace(/\/+$/, "") || "/";
        try { env.PWD = fs.cwd; } catch {}
      }
    },
  };
  const fn = new Function("fs", "env", "process", "sh2", `
    return (async () => { ${js} })();
  `);
  let v;
  try {
    v = await fn(fs, env, proc, rt.sh2);
  } catch (e) {
    if (e && e.exitCode !== undefined) return e.exitCode;  // `exit N`
    throw e;
  }
  return v === false ? 1 : 0;
}
