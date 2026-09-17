// ─── otranspile-jobs.js — the otranspiler page's compute, off the main thread ──
//
// The otranspiler web GUI (www/otranspiler.html) used to transpile AND run
// both sides inline, so one long output (e.g. a 67M-iteration factor loop
// in micropython, or the transpiled JS itself) froze the whole page until
// it finished. This module holds that compute DOM-free so it can run in
// Web Workers (www/otranspile-job.js) — one worker per stage (transpile,
// original run, target run), each with its OWN VirtualFS + runtimes.
//
// Importable from both realms:
//   • workers: `import { transpileJob, runJob } from "../src/otranspile-jobs.js"`
//     (each worker's module registry gives it a fresh `fs` singleton)
//   • main-thread fallback (no Worker support): the page imports the same
//     functions and runs them inline with ctx { fs, env, onStatus }.
//
// ctx = { fs, env, onStatus(text), wwwBase } — wwwBase is the absolute
// www/ URL (vendor/*.js, wasm-bin/* resolve under it); it defaults to
// src/../www/ which is correct both served (/j.cmd/src/ → /j.cmd/www/)
// and in Node (repo src/ → repo www/). It is also what the classic
// python worker (www/vendor/py-worker.js) is spawned from — see runPy.
// ---------------------------------------------------------------------------

import { fs as sharedFs } from "./fs/index.js";
import { env as sharedEnv } from "./env.js";
import { getOtranspilerl } from "./otranspilerl.js";
import { GoRunner, createGoCommand } from "./go.js";
import { WasmRunner } from "./wasm.js";
import { ensureBusyboxWasm, busyboxA1, BUSYBOX_VERSION } from "./busybox.js";
// re-exported so the page (which no longer imports busybox.js directly)
// can keep cache-busting its corpus-manifest fetches on the wasm version.
export { BUSYBOX_VERSION };
import { pyExec, pyExecInClassicWorker, isClassicWorker } from "./py.js";

const wwwFile = (rel) => new URL("../www/" + rel, import.meta.url).href;

function ctxFs(ctx) { return (ctx && ctx.fs) || sharedFs; }
function ctxEnv(ctx) { return (ctx && ctx.env) || sharedEnv; }
function onStatus(ctx, text) { try { ctx && ctx.onStatus && ctx.onStatus(text); } catch {} }

// Which languages have a runnable engine in this realm (java/rs render
// code but have no engine — the diff notes it). Single source of truth:
// the page imports RUNTIME_LABEL from here for its display strings.
export const RUNNABLE = { sh: 1, zsh: 1, fish: 1, go: 1, py: 1, c: 1, pl: 1, js: 1, zig: 1 };
export const RUNTIME_LABEL = {
  sh: "bash.wasm", zsh: "zsh.wasm", fish: "fish.wasm",
  go: "go.wasm (toolchain)", py: "micropython.wasm", c: "tcc.wasm",
  pl: "zeroperl.wasm (Perl 5.42)", js: "browser JS (sh2 runtime)",
  bat: "none (no cmd.exe in the browser)",
  glsl: "sh2glsl — in-process GLSL ES 1.00 compiler (fragment shader, not runnable)",
  glslv: "sh2glsl --vertex — in-process GLSL ES 1.00 vertex shader compiler (not runnable)",
  cpp: "none (no browser C++ runtime — the cpp frontend parses in-browser, executing the generated target needs g++)",
  powershell: "none (no browser pwsh/frontend wasm yet)",
  rust: "none (no browser Rust runtime — the rust frontend parses in-browser, executing the generated target needs rustc)",
  zig: "zig.wasm (toolchain — compiles AND runs)",
};
// Frontends merged into the busybox wasm (rust runs its own wasm via
// rustfrontend.js; powershell is fleet-only).
const FRONTEND_PORTED = { sh: 1, zsh: 1, fish: 1, go: 1, py: 1, c: 1, pl: 1, bat: 1, cpp: 1, zig: 1, rust: 1, js: 1 };
const FRONTEND_NAME = { powershell: "powershell-sh-go" };
const TARGETS_TEXT = ["sh", "pl", "c", "go", "py", "java", "rs", "zig"];

// ─── line map for TEXT targets (moved verbatim from the page) ────
// (see www/otranspiler.html history for the per-target rationale)
export function buildTextMap(text, tgt, a1Stmts, stmtLines) {
  const lines = String(text).split("\n");
  const srcLineOf = new Map();
  for (const e of stmtLines || []) srcLineOf.set(e.stmt, e.line);

  if (tgt !== "sh") {
    const map = [];
    let cur = null;
    for (let j = 0; j < lines.length; j++) {
      const m = /(?:#|\/\/|\/\*)\s*line (\d+)/.exec(lines[j]);
      if (m) {
        const line = Number(m[1]);
        let a1Idx = null;
        for (const [k, v] of srcLineOf) if (v === line) { a1Idx = k; break; }
        if (a1Idx != null) {
          if (cur) cur.jsEnd = j;
          cur = { jsStart: j + 1, jsEnd: j + 1, sourceLine: line };
          map.push(cur);
        } else if (cur) {
          cur.jsEnd = j + 1;
        }
      } else if (cur) {
        cur.jsEnd = j + 1;
      }
    }
    return map;
  }

  const count = (st, t) => {
    switch (st && st.type) {
      case "If": {
        let n = 1;
        n += (st.then || []).reduce((s, x) => s + count(x, t), 0);
        for (const [, b] of st.elsifs || []) n += 1 + b.reduce((s, x) => s + count(x, t), 0);
        if (st.else && st.else.length) n += 1 + st.else.reduce((s, x) => s + count(x, t), 0);
        return t === "py" ? n : n + 1;
      }
      case "For":
      case "While":
      case "DoWhile":
        return (t === "py" ? 1 : 2) + (st.body || []).reduce((s, x) => s + count(x, t), 0);
      case "Case": {
        let n = 1;
        for (const c of st.clauses || []) n += 1 + (c.body || []).reduce((s, x) => s + count(x, t), 0) + 1;
        return n + 1;
      }
      case "Function":
        return (t === "py" ? 1 : 2) + (st.body || []).reduce((s, x) => s + count(x, t), 0);
      default:
        return 1;
    }
  };

  const total = (a1Stmts || []).reduce((s, x) => s + count(x, tgt), 0);
  let last = lines.length - 1;
  while (last >= 0 && (
    lines[last].trim() === "" ||
    /^_\s*=\s*\w+;?$|^return(\s+\d+)?;?$/.test(lines[last].trim())
  )) last--;
  const bodyEnd = last;
  const bodyStart = Math.max(0, bodyEnd - total + 1);

  const map = [];
  let line = bodyStart + 1;
  (a1Stmts || []).forEach((st, idx) => {
    const n = count(st, tgt);
    const sl = srcLineOf.get(idx);
    if (sl) map.push({ jsStart: line, jsEnd: line + n - 1, sourceLine: sl });
    line += n;
  });
  return map;
}

// ─── transpile: source → A1 → target ─────────────────────────────
// Returns { text, map, a1, optShir, lex } — all structured-cloneable.
// `lex` is set for sh sources (the in-process lex stage); null otherwise.
export async function transpileJob(source, srcLang, tgt, ctx) {
  const fs = ctxFs(ctx);
  const lib = await getOtranspilerl();
  let text, a1 = null, map = null;
  if (srcLang === "sh") {
    if (tgt === "glsl") {
      text = lib.glsl(String(source));
    } else if (tgt === "glslv") {
      text = lib.glslv(String(source));
    } else {
      text = lib.transpile(String(source), "sh", tgt);
      try { a1 = JSON.parse(lib.shir(String(source))); } catch {}
    }
  } else if (srcLang === "rust") {
    const { rustfrontendA1 } = await import("./rustfrontend.js");
    a1 = await rustfrontendA1(String(source), fs, (m) => onStatus(ctx, m));
    text = lib.render(JSON.stringify(a1), tgt);
  } else if (!FRONTEND_PORTED[srcLang]) {
    throw new Error(srcLang + " frontend not ported to the browser wasm yet — " +
      "load it in the sh2loop fleet (" + (FRONTEND_NAME[srcLang] || srcLang) + ") to transpile");
  } else {
    const goRunner = new GoRunner(fs);
    const fetchBytes = async () => new Uint8Array(
      await (await fetch(wwwFile("wasm-bin/otranspiler-busybox.wasm?v=" + BUSYBOX_VERSION))).arrayBuffer());
    const wasmPath = await ensureBusyboxWasm(fs, { fetchBytes, onLog: (m) => onStatus(ctx, m) });
    a1 = await busyboxA1(String(source), srcLang, { fs, wasmPath, goRunner });
    text = lib.render(JSON.stringify(a1), tgt);
  }
  let optShir = null;
  if (a1) {
    try {
      optShir = lib.shirOpt(JSON.stringify(a1), tgt);
    } catch (e) { optShir = "shir_opt failed: " + e.message; }
  }
  let lex = null;
  if (srcLang === "sh" && tgt !== "glsl" && tgt !== "glslv") {
    try { lex = lib.lex(String(source)); } catch (e) { lex = "lex failed: " + e.message; }
  }
  if (tgt === "js") {
    const { estreeToJsMapped, keepVariables } = await import("./estree.js");
    const estree = JSON.parse(text);
    keepVariables(estree, [], { repl: false });
    const r = await estreeToJsMapped(estree, (a1 && a1.stmt_lines) || [], (a1 && a1.stmts) || [], { repl: false });
    return { text: r.js, map: r.map, a1, optShir, lex };
  }
  if (a1 && a1.stmt_lines && a1.stmt_lines.length && TARGETS_TEXT.indexOf(tgt) >= 0) {
    map = buildTextMap(text, tgt, a1.stmts, a1.stmt_lines);
  }
  return { text, map, a1, optShir, lex };
}

export async function otranspilerVersion() {
  return (await getOtranspilerl()).version();
}

// ─── runtimes (stdout capture) ──────────────────────────────────
const shellCache = {};
async function runShell(lang, script, ctx) {
  const fs = ctxFs(ctx);
  const glue = { sh: "bash.js", zsh: "zsh.js", fish: "fish.js" }[lang];
  if (!shellCache[lang]) {
    shellCache[lang] = (await import(wwwFile("vendor/" + glue))).default;
  }
  const factory = shellCache[lang];
  let out = "", err = "";
  let inFlight = 0;
  let code = 0;
  const ext = { sh: ".sh", zsh: ".zsh", fish: ".fish" }[lang];
  const path = "/script" + ext;
  const src = String(script).endsWith("\n") ? String(script) : String(script) + "\n";
  const hostRun = async (cmdline, stdinIn, appendOut = true) => {
    inFlight++;
    const { runBash } = await import("./bash2js.js");
    let ho = "", he = "", hcode = 0;
    try {
      hcode = await runBash(fs, cmdline, {
        stdout: { write: (s) => { ho += s; } },
        stderr: { write: (s) => { he += s; } },
        runCmd: async () => ({ out: "", err: "command not found\n", code: 127 }),
        args: [], argv0: "bash",
        stdin: stdinIn || "",
      });
    } catch { hcode = 127; }
    if (ho && appendOut) out += ho;
    if (he && appendOut) err += he;
    inFlight--;
    return { out: ho, err: he, code: hcode };
  };
  const cfg = {
    noInitialRun: lang !== "sh",
    arguments: lang === "sh" ? [path] : [],
    locateFile: (p) => wwwFile("wasm-bin/" + p),
    print: (t) => (out += t + "\n"),
    printErr: (t) => {
      err += t + "\n";
      const em = /program exited \(with status: (\d+)\)/.exec(t);
      if (em) code = Number(em[1]);
    },
    preRun: [() => {
      if (lang === "sh") {
        globalThis.__bash_spawn = async (args, stdin) => {
          if (!args || !args.length) return 127;
          const h = await hostRun(args.join(" "), stdin || "");
          return h.code;
        };
        globalThis.__bash_spawn_capture = async (cmd) => {
          const h = await hostRun(cmd, "", false);
          return { out: h.out, code: h.code };
        };
        globalThis.__bash_web_internal = (args) => {
          if (args && args.length) hostRun(args.join(" "), "");
          return 0;
        };
      }
      cfg.FS.writeFile(path, src);
    }],
  };
  const m = await factory(cfg);
  if (lang !== "sh") {
    try { m.callMain(lang === "zsh" ? ["-f", path] : [path]); } catch (e) { code = (e && e.exitStatus) || (e && e.status) || 1; }
  } else {
    const deadline = Date.now() + 30000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  err = err.split("\n").filter((l) =>
    !/^program exited \(with status/.test(l) &&
    !/^warning: unsupported syscall/.test(l) &&
    !/^warning: stdio streams had content/.test(l) &&
    !/^warning: Invalid UTF-8/.test(l)
  ).join("\n");
  return { out, err, code };
}

async function runJs(jsCode, ctx) {
  const fs = ctxFs(ctx);
  const env = ctxEnv(ctx);
  let out = "", err = "";
  const outS = { write: (s) => { if (s) out += String(s); } };
  const { createSh2Runtime } = await import("./sh2runtime.js");
  const rt = createSh2Runtime({ fs, env, shellExec: async () => ({ out: "", err: "", code: 0 }), stdout: outS, stderr: outS, args: [], argv0: "sh" });
  const proc = {
    stdout: outS, stderr: outS, pid: 1, argv: ["otranspiler"], env: env || {},
    cwd: () => (fs.cwd !== undefined ? fs.cwd : "/") || "/",
    chdir(p) { try { if (fs.cwd !== undefined) fs.cwd = String(p).replace(/\/+$/, "") || "/"; } catch {} },
    exit(code) { const e = new Error("__otranspiler_exit__" + code); e.exitCode = Number(code) || 0; throw e; },
  };
  const fn = new Function("fs", "env", "process", "sh2", `return (async () => { ${jsCode} })();`);
  let code = 0;
  try { await fn(fs, env, proc, rt.sh2); } catch (e) { if (e.exitCode !== undefined) code = e.exitCode; else throw e; }
  return { out, err, code };
}

// ─── python: always a CLASSIC worker ────────────────────────────
// The micropython glue is a classic emscripten script, so it CANNOT run
// in this module worker (www/otranspile-job.js is spawned with
// `{ type: "module" }`): importScripts() is illegal in module scope, and
// a dynamic import() of the glue evals it with `var Module` in MODULE
// scope, so self.Module stays undefined. Attempting it threw
//   "Module scripts don't support importScripts()"
// and every python run on the otranspiler page failed.
//
// So python runs are bridged to the nested classic Web Worker
// (www/vendor/py-worker.js) — the same engine worker the auto_cython
// page uses. On the MAIN thread (no-Worker fallback) pyExec is correct
// as-is: the glue is a <script> in the page and Module is window.Module.
async function runPy(src, ctx) {
  let out = "", err = "";
  const stdout = { write: (s) => { out += s; } };
  const stderr = { write: (s) => { err += s; } };
  // A module worker defines importScripts but throws when it is CALLED,
  // so the realm must be probed behaviourally (py.js's isClassicWorker) —
  // a `typeof` test here silently picked pyExec and reproduced the bug.
  if (typeof WorkerGlobalScope !== "undefined" && !isClassicWorker()) {
    const code = await pyExecInClassicWorker(String(src), {
      stdout, stderr, base: (ctx && ctx.wwwBase) || undefined,
    });
    return { out, err, code };
  }
  const code = await pyExec(String(src), { stdout, stderr });
  return { out, err, code };
}

async function runPl(src, ctx) {
  const { ZeroPerl } = await import(wwwFile("vendor/zeroperl.mjs"));
  let out = "", err = "";
  const dec = new TextDecoder();
  const perl = await ZeroPerl.create({
    fetch: () => fetch(wwwFile("vendor/zeroperl.wasm")),
    stdout: (s) => { out += typeof s === "string" ? s : dec.decode(s); },
    stderr: (s) => { err += typeof s === "string" ? s : dec.decode(s); },
    args: ["zeroperl"],
  });
  const r = await perl.eval(String(src));
  try { await perl.flush(); } catch {}
  return { out, err, code: r.success ? (r.exitCode || 0) : 1, note: r.success ? "" : (r.error || "") };
}

async function runGo(src, ctx) {
  const fs = ctxFs(ctx);
  const goRunner = new GoRunner(fs);
  let out = "", err = "";
  const goCmd = createGoCommand(goRunner, (s) => { out += s; }, (s) => { err += s; });
  try { await fs.write("/tmp/go-webgui/.directory", ""); } catch {}
  await fs.write("/tmp/go-webgui/main.go", String(src));
  const prevCwd = fs.cwd;
  try { fs.cwd = "/tmp/go-webgui"; } catch {}
  let code = 1;
  try { code = await goCmd(["run", "main.go"]); } finally { fs.cwd = prevCwd; }
  out = out.split("\n").filter((l) => !/^go (run|build): /.test(l)).join("\n");
  return { out, err, code };
}

async function runZig(src, ctx) {
  const fs = ctxFs(ctx);
  const { WasmerRegistry } = await import("./wasmer.js");
  const reg = new WasmerRegistry(fs);
  let inst;
  try { inst = await reg.install("zig"); } catch (e) {
    return { out: "", err: "zig toolchain unavailable: " + (e && e.message || e), code: 1 };
  }
  void inst;
  const wasmRunner = new WasmRunner(fs);
  try { await fs.write("/tmp/zig-webgui/.directory", ""); } catch {}
  await fs.write("/tmp/zig-webgui/main.zig", String(src));
  const prevCwd = fs.cwd;
  try { fs.cwd = "/tmp/zig-webgui"; } catch {}
  try {
    await wasmRunner.run("/usr/bin/zig.wasm", ["zig", "build-exe", "/tmp/zig-webgui/main.zig", "-femit-bin=main.wasm"]);
    const ccode = wasmRunner.getExitCode();
    const cerr = wasmRunner.getStderr();
    if (ccode !== 0) return { out: wasmRunner.getStdout(), err: cerr, code: ccode };
    wasmRunner.invalidate("/main.wasm");
    await wasmRunner.run("/main.wasm", ["main"]);
    return { out: wasmRunner.getStdout(), err: wasmRunner.getStderr(), code: wasmRunner.getExitCode() };
  } finally { fs.cwd = prevCwd; }
}

async function runC(src, ctx) {
  const fs = ctxFs(ctx);
  const { runTcc } = await import("./tcc.js");
  const wasmRunner = new WasmRunner(fs);
  const fetchBundle = async (rel) => new Uint8Array(
    await (await fetch(wwwFile(rel))).arrayBuffer());
  try { await fs.write("/tmp/c-webgui/.directory", ""); } catch {}
  await fs.write("/tmp/c-webgui/main.c", String(src));
  const outWasm = "/tmp/c-webgui/a.wasm";
  await runTcc({ vfs: fs, runner: wasmRunner, args: ["/tmp/c-webgui/main.c", "-o", outWasm], fetchBundle });
  const ccode = wasmRunner.getExitCode();
  const cerr = wasmRunner.getStderr();
  if (ccode !== 0) return { out: wasmRunner.getStdout(), err: cerr, code: ccode };
  wasmRunner.invalidate(outWasm);
  await wasmRunner.run(outWasm, []);
  return { out: wasmRunner.getStdout(), err: wasmRunner.getStderr(), code: wasmRunner.getExitCode() };
}

// ─── py2cy: the auto-typed-Cython annotator job ─────────────────
// The auto_cython page's compute. It is pure source→source (no wasm),
// but it lives here for the same reason the transpile stage does: the
// page runs it in a worker so a big module's analysis cannot block the
// UI. `mode` is "pure" (default, §5 mode 2) or "pyx" (§5 mode 1).
export async function annotateJob(source, mode, ctx) {
  const { annotate } = await import("./py2cy.js");
  onStatus(ctx, "annotating " + (mode === "pyx" ? ".pyx" : "pure-Python mode") + "…");
  const r = annotate(String(source), { mode });
  return {
    text: r.text,
    mode: r.mode,
    decls: r.decls,
    refusals: r.refusals,
    stats: r.stats,
  };
}

// Run one side (original source or generated target). Returns the
// { out, err, code, note? } record, or null when the language has no
// engine in this realm (the page renders the compile-only note).
export async function runJob(lang, source, ctx) {
  const label = RUNTIME_LABEL[lang] || lang;
  onStatus(ctx, "running " + lang + " (" + label + ")…");
  try {
    switch (lang) {
      case "sh": case "zsh": case "fish": return await runShell(lang, source, ctx);
      case "js": return await runJs(source, ctx);
      case "py": return await runPy(source, ctx);
      case "pl": return await runPl(source, ctx);
      case "go": return await runGo(source, ctx);
      case "c": return await runC(source, ctx);
      case "zig": return await runZig(source, ctx);
      default: return null; // java/rs: no engine
    }
  } catch (e) {
    return { out: "", err: String((e && e.message) || e), code: 1 };
  }
}
