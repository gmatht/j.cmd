// ─── jtsh: Minimal shell that runs .js files as commands ──────
//
// jtsh is to the virtual filesystem what /bin/sh is to a Unix kernel.
// It reads lines, splits on spaces, and executes .js files.
//
// JavaScript is the "machine code" of this architecture.
// jtsh is the "CPU" that runs it — minimal, dumb, reliable.
//
// Usage:
//   node src/jtsh.js           # interactive REPL
//   node src/jtsh.js < file    # batch mode from stdin
// -----------------------------------------------------------------

import { createInterface } from "readline";
import { createShellCore } from "./shellcore/index.js";
import { resolveCommand as shellResolve, isPrivilegedUser, customExecDenied } from "./shellcore/resolve.js";
import { tokenize } from "./shellcore/tokenize.js";
import { a1LiteralValue, syncOtVarsFromStore, runSourceContent as sharedRunSourceContent, evalProgramOnOtRt, transpileLine as sharedTranspileLine, ensureOtRuntime as sharedEnsureOtRuntime, runShellScript as sharedRunShellScript } from "./shellcore/transpile.js";
import { handleLine as sharedHandleLine, runConditionalList as sharedRunConditionalList, runPipeline as sharedRunPipeline, splitBgList as sharedSplitBgList, splitConditionals as sharedSplitConditionals, splitPipe as sharedSplitPipe, looksLikeBash as sharedLooksLikeBash } from "./shellcore/runner.js";
import { pipeText as sharedPipeText, pipeBytes as sharedPipeBytes, joinOut as sharedJoinOut, UUTILS_COMMANDS as sharedUUTILS_COMMANDS, ensureUutilsWasm as sharedEnsureUutilsWasm, runUutilsCommand as sharedRunUutilsCommand } from "./shellcore/runner.js";
import { runSegment as sharedRunSegment, InterruptError, runPythonCmd as sharedRunPythonCmd } from "./shellcore/runner.js";
import { globExpandTokens as sharedGlobExpandTokens } from "./shellcore/glob.js";
import { runReplLine as sharedRunReplLine } from "./shellcore/repl.js";

// pipe/uutils helpers — SHARED (shellcore/runner.js)
const pipeText = (d) => sharedPipeText(d);
const pipeBytes = (d) => sharedPipeBytes(d);
const joinOut = (chunks) => sharedJoinOut(chunks);

async function writeOut(file, data, append) {
  if (append) {
    // >> — read the existing content and concatenate
    let existing = null;
    try {
      existing = data instanceof Uint8Array ? await fs.readBlob(file) : await fs.read(file);
    } catch {}
    if (data instanceof Uint8Array) {
      const parts = [existing || new Blob([]), new Blob([data])];
      return fs.writeBlob(file, new Blob(parts));
    }
    return fs.write(file, (existing || "") + data);
  }
  if (data instanceof Uint8Array) await fs.writeBlob(file, new Blob([data]));
  else await fs.write(file, data);
}
const UUTILS_COMMANDS = sharedUUTILS_COMMANDS;
const ensureUutilsReadBin = async (name) => {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(new URL("../www/wasm-bin/" + name, import.meta.url)));
};
const ensureUutilsWasm = () => sharedEnsureUutilsWasm(fs, ensureUutilsReadBin);

// ─── line/pipeline runners — SHARED (shellcore/runner.js) ─────────
// The split helpers, conditional-list and pipeline runners are one
// implementation; runSegment stays per-shell (it weaves procfs, jobs
// and the output targets) and comes through shellCtx.
const handleLine = (line, initialStdin) => sharedHandleLine(line, initialStdin, shellCtx);
const runConditionalList = (text, initialStdin) => sharedRunConditionalList(text, initialStdin, shellCtx);
const runPipeline = (pipelineText, initialStdin = "") => sharedRunPipeline(pipelineText, initialStdin, shellCtx);
const splitBgList = (line) => sharedSplitBgList(line);
const splitConditionals = (line) => sharedSplitConditionals(line);
const splitPipe = (line) => sharedSplitPipe(line);
const looksLikeBash = (text) => sharedLooksLikeBash(text);
import { fs } from "./fs/index.js";
import { formatAge } from "./fs/lscache.js";
import { WasmRunner } from "./wasm.js";
import { WasmerRegistry } from "./wasmer.js";
import { materializeBinCommand } from "./binsync.js";
import { env, expandRef, setShellStatus, getShellStatus, setLastBgPid,
         setPositional, getPositional, getArgv0, setOption, hasOption,
         markReadonly, isReadonly, listReadonly } from "./env.js";
import { procfs } from "./fs/procfs.js";
import { bashToJS, runBash, buildSh2LibFacade } from "./bash2js.js";
import { createSh2Runtime } from "./sh2runtime.js";
import { createJobScheduler, createBgJobs } from "./jobs.js";
import { getManPage, manIndex, searchManPages, MAN_PAGES } from "./manpages.js";
import { GoRunner, createGoCommand } from "./go.js";
import { createCliNethackCommand } from "./nethack.js";
import { qbe2wasm } from "./qbe2wasm.js";

const wasmRunner = new WasmRunner(fs);
const sh2libFacade = buildSh2LibFacade(fs);  // debashl toolchain, injected into .js commands
const wasmerReg = new WasmerRegistry(fs);
const goRunner = new GoRunner(fs, { baseUrl: "www/" });
let ccCounter = 0;

// Terminal-output ring buffer (for the `bug` command): the last 1000
// lines written to stdout/stderr, so a report can carry the terminal
// context even without the browser DOM. Patched in at the bottom of
// the write chain — every guard/capture wrapper restores to this.
const outRing = [];
function ringPush(s) {
  if (typeof s !== "string") return;
  for (const line of s.split("\n")) outRing.push(line);
  while (outRing.length > 1000) outRing.shift();
}

// System info for bug reports: node/platform line + sha256 of the core
// files (pins the exact code) — the CLI analogue of /dev/info.
async function collectSystem() {
  const parts = [];
  parts.push(`node ${process.version} · ${process.platform}/${process.arch}`);
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const core = ["www/index.html", "src/jtsh.js", "src/fs/index.js", "src/wasm.js", "src/c-runtime.js", "src/qbe2wasm.js", "src/bugreport.js"];
  for (const f of core) {
    try {
      const hex = createHash("sha256").update(readFileSync(f)).digest("hex");
      parts.push(`sha256 ${f}: ${hex}`);
    } catch {
      parts.push(`sha256 ${f}: (unreadable)`);
    }
  }
  return parts.join("\n");
}

// The exact commit the shell was built from: git in a repo clone,
// else www/version.txt (the Pages build stamp).
async function collectCommit() {
  try {
    const { execSync } = await import("node:child_process");
    return execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
  } catch {
    try {
      const { readFileSync } = await import("node:fs");
      const m = readFileSync("www/version.txt", "utf8").match(/^commit:\s*(\S+)/m);
      return m ? m[1] : "";
    } catch { return ""; }
  }
}
const _bugBaseOut = process.stdout.write.bind(process.stdout);
const _bugBaseErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (s, ...rest) => { ringPush(s); return _bugBaseOut(s, ...rest); };
process.stderr.write = (s, ...rest) => { ringPush(s); return _bugBaseErr(s, ...rest); };
// libc declarations for C source compiled by cproc: the shell strips
// #include/#define lines (no stdio.h in the sandbox) and injects these,
// matching the env runtime (src/c-runtime.js) that the binaries link to.
const CPROC_DECLS = `int printf(const char*, ...);\nint puts(const char*);\nint putchar(int);\nint fprintf(void*, const char*, ...);\nint sprintf(char*, const char*, ...);\nvoid *malloc(unsigned long);\nvoid *calloc(unsigned long, unsigned long);\nvoid *realloc(void*, unsigned long);\nvoid free(void*);\nunsigned long strlen(const char*);\nint strcmp(const char*, const char*);\nchar *strcpy(char*, const char*);\nchar *strncpy(char*, const char*, unsigned long);\nchar *strcat(char*, const char*);\nvoid *memcpy(void*, const void*, unsigned long);\nvoid *memmove(void*, const void*, unsigned long);\nvoid *memset(void*, int, unsigned long);\nint memcmp(const void*, const void*, unsigned long);\nvoid exit(int);\nvoid abort(void);\ntypedef int (*qsort_cmp)(const void*, const void*);\nvoid qsort(void*, unsigned long, unsigned long, qsort_cmp);\nvoid *bsearch(const void*, const void*, unsigned long, unsigned long, qsort_cmp);\n`;

// Preprocess C source for the compilers: strip #include/#define lines
// (no headers in the sandbox — the decls above stand in for stdio.h
// etc.) while keeping any user declarations.
function preprocessC(src) {
  const body = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  return body.includes("int printf(") ? body : CPROC_DECLS + body;
}
// tcc's wasm32 backend emits an INVALID module for void main (its
// _start does `call main; call proc_exit` and nothing is pushed) — the
// only broken construct we've found. Normalize to int main (C99 gives
// main an implicit return 0). cc/cproc handle void main fine and keep
// the source untouched.
const TCC_VOID_MAIN_FIX = (src) => src.replace(/\bvoid\s+main\s*\(/g, "int main(");
const goCmd = createGoCommand(goRunner);
const nethackCmd = createCliNethackCommand();

// Pipe input for the current command — the previous pipeline segment's
// captured stdout. Builtins that read stdin (head, ...) consume this.
let stdinBuffer = "";
// Raw form of the pipe input (string or Uint8Array) for binary-safe
// consumers like cat, which must not round-trip bytes through UTF-8.
let rawStdin = "";

// ─── Pipe data ──────────────────────────────────────────────────
// A pipeline segment's stdout is either text (string) or raw bytes
// (Uint8Array — wasm programs, gzip output, ...). The pipe itself
// carries both; these helpers convert at the boundaries that need a
// specific kind:
//   pipeText  — bytes → UTF-8 string (text consumers: head/grep, the
//               terminal, JS command `stdin` args)
//   pipeBytes — string → UTF-8 bytes (binary consumers)
//   joinOut   — joins captured write chunks, preserving binary chunks

// ─── Ctrl+C (SIGINT) interruption ──────────────────────────────
// A real shell delivers SIGINT to the foreground process; here that
// means: abort the running command and return to the prompt with
// status 130 (128 + SIGINT). JS can't hard-kill an in-flight async
// function, so we race the command against an interrupt signal and
// abandon it — remaining output from the aborted command is dropped
// (suppressOutput) until a newer command takes over the terminal.
// At an idle prompt, Ctrl+C cancels the current input line.

let running = false;        // a command is executing right now
let interruptSignal = null; // rejects the running command's race
let suppressOutput = false; // drop output from an aborted command
let runId = 0;
let interruptCallbacks = [];  // shell.onInterrupt hooks (watch etc.)              // bumped per command — stale aborts don't linger

// Run a command's promise so that Ctrl+C can abort it. Returns the
// command's exit code (130 if interrupted).
async function runInterruptible(promise) {
  const myId = ++runId;
  suppressOutput = false;
  running = true;
  let rejectFn = null;
  interruptSignal = () => {
    if (rejectFn) rejectFn(new InterruptError());
    for (const cb of interruptCallbacks) { try { cb(); } catch {} }
    interruptCallbacks = [];
  };
  const interruptible = new Promise((_, reject) => { rejectFn = reject; });

  let code = 0;
  try {
    code = await Promise.race([promise, interruptible]);
  } catch (e) {
    if (e instanceof InterruptError) {
      code = 130; // 128 + SIGINT, like a real shell
      suppressOutput = true;
      // The aborted command keeps running in the background; its
      // output stays suppressed until it settles (unless a newer
      // command has taken over the terminal).
      Promise.resolve(promise).catch(() => {}).finally(() => {
        if (runId === myId) suppressOutput = false;
      });
    } else {
      throw e;
    }
  } finally {
    running = false;
    interruptSignal = null;
  }
  return code;
}

// ─── Built-in Commands ─────────────────────────────────────────

const builtins = {
  async printf(args) {
    // printf FORMAT [args…] — the bash builtin, enough for the sh
    // renderers' %s/%d/%f/%x/%o/%c/%% plus \n \t escapes.
    const fmt = args[0] ?? "";
    let out = "";
    let a = 1;
    const runOnce = () => {
      let i = 0;
      while (i < fmt.length) {
        const ch = fmt[i];
        if (ch === "\\") {
          const e = fmt[i + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "\\" ? "\\" : e === "0" ? "\0" : (e || "");
          i += 2;
        } else if (ch === "%") {
          const spec = fmt.slice(i + 1).match(/^[-+ #0]*\d*(?:\.\d+)?(.)/);
          const conv = spec ? spec[1] : "%";
          i += 1 + (spec ? spec[0].length : 0);
          if (conv === "%") { out += "%"; continue; }
          const arg = args[a++];
          if (conv === "s") out += String(arg ?? "");
          else if (conv === "d" || conv === "i") out += String(Math.trunc(Number(arg) || 0));
          else if (conv === "f") out += String(Number(arg) || 0);
          else if (conv === "x") out += Math.trunc(Number(arg) || 0).toString(16);
          else if (conv === "X") out += Math.trunc(Number(arg) || 0).toString(16).toUpperCase();
          else if (conv === "o") out += Math.trunc(Number(arg) || 0).toString(8);
          else if (conv === "c") out += String(arg ?? "")[0] ?? "";
          else { out += "%" + (spec ? spec[0] : ""); i--; }
        } else {
          out += ch;
          i++;
        }
      }
    };
    // bash reuses the format string until every argument is consumed
    // (`printf "%s|" 1 2 3` → "1|2|3|"); a %% -only format never
    // consumes, so stop when a pass didn't advance.
    runOnce();
    while (a < args.length) {   // args[1..] are the arguments — reuse the
      const before = a;         // format until they're all consumed
      runOnce();
      if (a === before) break;  // %% -only format never consumes — stop
    }
    process.stdout.write(out);
    return 0;
  },

  async cls(args) {
    // cls — Windows-style alias for clear
    process.stdout.write("\x1b[2J\x1b[H");
    return 0;
  },

  async ln(args) {
    // ln [-s] [-f] TARGET LINK — create a link. Only symbolic links
    // are supported: the VFS has no inodes, so hard links can't exist.
    // `ln -s target dir/` places a link named after the target in dir.
    let symbolic = false;
    let force = false;
    const operands = [];
    for (const a of args) {
      if (a === "-s" || a === "--symbolic") symbolic = true;
      else if (a === "-f" || a === "--force") force = true;
      else if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
        // Combined short flags: -sf, -fs
        let ok = true;
        for (const c of a.slice(1)) {
          if (c === "s") symbolic = true;
          else if (c === "f") force = true;
          else ok = false;
        }
        if (!ok) {
          process.stderr.write(`ln: invalid option -- '${a}'\n`);
          return 2;
        }
      } else if (a.startsWith("-")) {
        process.stderr.write(`ln: invalid option -- '${a}'\n`);
        return 2;
      } else operands.push(a);
    }
    if (operands.length < 2) {
      process.stderr.write("ln: missing operand\n");
      process.stderr.write("usage: ln [-s] [-f] TARGET LINK\n");
      return 2;
    }
    if (!symbolic) {
      process.stderr.write("ln: hard links are not supported (the VFS has no inodes) — use: ln -s TARGET LINK\n");
      return 1;
    }
    const target = operands[0];
    let link = operands[1];
    const wantsDir = link.endsWith("/");
    if (wantsDir) {
      // GNU ln: a trailing slash demands an existing directory, and the
      // link is placed inside it, named after the target.
      try {
        const st = await fs.stat(link);
        if (!st || st.type !== "dir") throw new Error("not a directory");
      } catch (e) {
        process.stderr.write(`ln: failed to access '${link}': ${e.message}\n`);
        return 1;
      }
      const base = target.split("/").filter(Boolean).pop() || target;
      link = link.replace(/\/+$/, "") + "/" + base;
    } else {
      // `ln -s target dir` (existing dir, no slash) → dir/basename(target)
      try {
        const st = await fs.stat(link);
        if (st && st.type === "dir") {
          const base = target.split("/").filter(Boolean).pop() || target;
          link = link.replace(/\/+$/, "") + "/" + base;
        }
      } catch {
        // Not a dir — treat the operand as the link path itself.
      }
    }
    if (force) {
      try { await fs.remove(link); } catch {}
    }
    try {
      await fs.link(target, link);
      return 0;
    } catch (e) {
      process.stderr.write(`ln: ${link}: ${e.message}\n`);
      return 1;
    }
  },

  async readlink(args) {
    // readlink [file...] — print the targets of symbolic links
    if (args.length === 0) {
      process.stderr.write("readlink: missing operand\n");
      return 2;
    }
    let hadError = false;
    for (const f of args) {
      try {
        process.stdout.write((await fs.readlink(f)) + "\n");
      } catch (e) {
        hadError = true;
        process.stderr.write(`readlink: ${f}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  // `source file` / `. file` — run a file in the CURRENT shell context
  // (bash's source): reads the file, transpiles it through the unified
  // pipeline (sh/zsh in-process; fish/c/go/py/pl via the merged busybox
  // frontend) → estree → JS, runs it in the persistent REPL runtime and
  // harvests the variables it set back into the shell.,,,
  "cmd.exe": async (args) => await builtins.cmdExe(args),
  cmd: async (args) => await builtins.cmdExe(args),
  ".": async (args) => await builtins.source(args),
};

// ── the SHARED shell core (src/shellcore) — the same builtins the
// browser shell runs, bound to THIS shell's ctx (I/O + machinery). The
// CLI-only builtins above (ln/printf/readlink) and the aliases stay
// local; everything else lives in one implementation.
const shellCtx = {
  stdout: process.stdout,
  stderr: process.stderr,
  write: (s) => process.stdout.write(s),
  get stdin() { return stdinBuffer; },
  get isTTY() { return Boolean(process.stdin.isTTY); },
  fs,
  shellExec: runNestedCommand,
  runNestedCommand,
  findCommand: (name) => shellResolve(shellCtx, name),
  resolveCommand: (name) => shellResolve(shellCtx, name),
  get builtins() { return builtins; },
  autoLoad: async (name) => {
    // Lazy /bin command templates (www/bin/) — materialize on first use
    // (perl, lua, tar, zip, mail, …). Only bare names are auto-loaded.
    if (!name.includes("/")) {
      const p = await materializeBinCommand(name);
      if (p) { const denied = customExecDenied(p); if (denied) return denied; return { type: "file", path: p }; }
    }
    // a wasm binary from wasm-bin/ (the CLI has no server — node fetches
    // the same URL the browser does; falls through when offline)
    if (!isPrivilegedUser()) return null;
    let wasmName = name;
    if (name === "cc") wasmName = "compiler";
    try {
      const resp = await fetch("wasm-bin/" + wasmName + ".wasm");
      if (resp.ok) {
        const blob = await resp.blob();
        const destPath = "/usr/bin/" + name + ".wasm";
        await fs.writeBlob(destPath, blob);
        return { type: "wasm", path: destPath };
      }
    } catch {}
    return null;
  },
  ensureOtRuntime,
  get otRt() { return otRt; },
  syncOtVarsFromStore: () => syncOtVarsFromStore(otRt, otVars),
  runSourceContent: (content, lang, srcArgs) => sharedRunSourceContent(content, lang, srcArgs, shellCtx),
  // a .js source file IS generated JS — the shared eval+harvest helper
  // runs it on the persistent runtime (the file's own $@ = srcArgs)
  runJsSourceContent: (content, srcArgs) => evalProgramOnOtRt(content, { positional: srcArgs }, shellCtx),
  // state/backend accessors the shared runSourceContent weaves through
  getOtVars: () => otVars,
  goRunner,
  fetchBusyboxBytes: async () => {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(new URL("../www/wasm-bin/otranspiler-busybox.wasm", import.meta.url)));
  },
  evalProgram: (program, lineAssigned, srcArgs) => runEstreeProgram(program, lineAssigned, srcArgs),
  stdinBuffer: () => stdinBuffer,
  otProc: () => otProc,
  stdoutWrite: (s) => process.stdout.write(s),
  stderrWrite: (s) => process.stderr.write(s),
  setOtRt: (r) => { otRt = r; },
  setOtProc: (p) => { otProc = p; },
  // runSegment ctx (the SHARED command executor)
  globExpand: (tokens) => sharedGlobExpandTokens(tokens),
  interceptCommand: interceptCompilers,
  suppressOutput: () => suppressOutput,
  get stdinBuffer() { return stdinBuffer; },
  set stdinBuffer(v) { stdinBuffer = v; },
  set rawStdin(v) { rawStdin = v; },
  runPythonCmd,
  enterPerlRepl: enterPerlRepl,
  runRealBash: (content, opts) => import("./realbash.js").then((m) => m.runRealBash(content, opts)),
  runShellScript,
  runNestedCommand,
  goRunner,
  env,
  getJobScheduler,
  onInterrupt: (fn) => interruptCallbacks.push(fn),
  get keyCallbacks() { return []; },
  get interruptCallbacks() { return interruptCallbacks; },
  sh2libFacade,
  qbe2wasm,
  readBin: ensureUutilsReadBin,
  writeOut,
  builtinCapture: null,
  ensureOtRuntime: () => ensureOtRuntime(),
  wasmRunner,
  goCmd,
  isPrivilegedUser,
  getBgJobs,
  runViaTranspiler,
  runSegment,
  promptRepl: () => {
    if (replState.active) {
      rl.setPrompt(replState.mode === "perl" ? "perl> " : replState.mode === "bash" ? "bash> " : replState.mode === "cmd" ? "cmd> " : ">>> ");
      rl.prompt();
    }
  },
  enterRepl: (mode) => { if (mode === "bash") enterBashRepl(); else enterCmdRepl(); },
  exit: () => process.exit(0),
  nodeEnv: typeof process !== "undefined" ? process.env : undefined,
  nodeCwd: () => (typeof process !== "undefined" ? process.cwd() : "/"),
};
const { builtins: sharedBuiltins } = createShellCore(shellCtx);
Object.assign(builtins, sharedBuiltins);
// the shared resolver, bound to this shell's ctx (the dispatcher calls
// resolveCommand; the shared builtins call ctx.findCommand — same thing)
const resolveCommand = (name) => shellResolve(shellCtx, name);

// ─── Command Resolution ─────────────────────────────────────────

// Look up where `name` would be found, without side effects: a wasm32-
// wasi binary in the command path first (it shadows the builtin of the
// same name — so `wasmer install grep`, which drops /bin/grep.wasm,
// makes `grep` run real grep compiled to WASM instead of the JS
// fallback), then builtins, then command files (.js/.mjs/.wasm) in
// $PATH. Returns the same shapes as resolveCommand, or null.
//
// A name containing a "/" is an explicit path, like in /bin/sh: it is
// resolved against the cwd and run directly (./a.wasm, /home/x.js,
// ../run.mjs) instead of being looked up in $PATH. Bare names never
// fall back to the cwd — that's what the leading ./ is for.
// Unprivileged users (su nobody/daemon/guest/...) may only run
// admin-trusted code: builtins and .js/.wasm files owned by jtsh.
// Custom code (anything they — or another non-admin — created) is
// refused, so an unprivileged session can't escalate by dropping a
// .js/.wasm file and running it.
// Mobile keyboards auto-capitalize the first letter of a sentence, so
// `Ls` and `ls` should be the same command. Exact-name matches always
// win; the fold only applies to bare command names (no "/") whose
// first letter is uppercase. `which Ls` benefits too.
// ─── Line Handler ───────────────────────────────────────────────

// Tokenize a pipeline segment into words the way a shell does:
//   whitespace separates words (outside quotes)
//   '...'  single quotes — everything literal until the closing quote
//   "..."  double quotes — backslash escapes only " \ $ and ` (POSIX),
//          everything else (spaces, |, *...) stays literal
//   \x     outside quotes — escapes the next character ("\ " → space)
//   "" / ''               — produce an empty word
// Throws an Error with a shell-style message if a quote is left open.

// Split a line into pipeline segments on `|`, respecting quotes and
// backslash escapes (a \| outside quotes is a literal pipe char).

// Execute one pipeline segment. `stdin` carries the previous segment's
// stdout. Returns { ok, output } — `output` is the captured stdout that
// should be fed to the next segment (empty for the last segment).
// ─── otranspilerl fallback: bash concepts jtsh's parser doesn't know ──
// Lines carrying bash-only syntax — statement separators (`;`), the
// for/while/if/case keywords, `$(…)` command substitution, `[[ ]]` —
// route through the unified otranspilerl library (the real debashl core
// + estree backend): sh → A1 shIR → ESTree → JS, executed with the sh2.*
// runtime. `x=5; echo $x`, `for i in …; do …; done`, `if …; then …; fi`
// and friends just work; constructs needing the sync bridge
// (command substitution, pipelines, redirection) refuse loudly with a
// pointer to `bash`.

// Does the line carry bash syntax jtsh's tokenizer doesn't handle?
// (Quoted text is ignored — `echo 'a;b'` is one argument, not bash.)

// Transpile a bash line with otranspilerl and execute the generated JS.
// Returns the exit code; throws when the library refuses or the shape
// needs the sync bridge (caller falls back to the normal error path).
// The sh2 runtime + process shim are created ONCE and shared by every
// call, so state (functions, sh2.lastExit, cwd via fs) survives across
// lines. NB: plain shell variables (x=5) are emitted as bare JS
// identifiers in each eval's function scope, so they reset per line —
// only the bash REPL's session replay preserves them.
let otRt = null;     // persistent createSh2Runtime result
let otProc = null;   // process shim for the generated JS

// Lazily build the persistent transpiled-bash runtime (shared by the
// line fallback, sourcing, and JS sources). Created once; state —
// functions (sh2.functions), sh2.lastExit, positionals, vars — survives
// across lines.
async function ensureOtRuntime() {
  return sharedEnsureOtRuntime(shellCtx);
}
// Persistent shell-variable state across transpiled lines. The debashl
// compiler folds `$x` reads to "" when x isn't assigned in the same
// program, so each line is SEEDED with the known variables (assignments
// prepended — reads then compile live), and after the run the variables
// the line set are HARVESTED back: bare assignments (`x = 5`) land on
// globalThis (sloppy new Function), `sh2.vars.*` writes land in the
// runtime's map — both are diffed against a before-snapshot.
let otVars = new Map();

// Sync the persistent runtime's store back into otVars after a NATIVE
// command mutated it (e.g. a function dispatched via findCommand sorting
// an array in place). The transpiled-line SEED replays otVars before
// every runViaTranspiler program — a stale snapshot would clobber the
// live store (my_qsort's in-place sort would be erased by the next
// transpiled line's `a=(...)` seed). Same keepable/readonly rules as the
// evalOnOtRt harvest.

// The A1 contract's Assign expr → literal value, or undefined when
// computed (Str → string; setArray Call → array of strings; anything
// else → the runtime diffs below harvest it if it materializes).

// ─── runShellScript: execute a whole bash SCRIPT (.sh file / #! file) ──
// Transpiles the entire file with the unified otranspilerl compiler (the
// same engine as the line fallback — it handles backtick seq ranges and
// arithmetic in for-headers that the debashcl path mis-joins), then runs
// it against a FRESH sh2 runtime: script variables stay script-local,
// like bash. Returns the exit code.
async function runShellScript(content, opts = {}) {
  return sharedRunShellScript(content, opts, shellCtx);
}

async function runViaTranspiler(segmentText, stdin) {
  return sharedTranspileLine(segmentText, shellCtx);
}

async function runEstreeProgram(program, lineAssigned, srcArgs) {
  // KEEP_VARIABLES: route known array state through the persistent
  // runtime store (bare `a[1]`/`a.length` reads → arrayIndex/arrayLen;
  // `let a = [...]` declarations also sync to sh2.vars).
  const { estreeToJs, keepVariables } = await import("./estree.js");
  keepVariables(program, [...otVars].filter(([, v]) => Array.isArray(v)).map(([k]) => k));
  // The estree convention: each statement's value is the command's
  // success flag (true/false). Make the LAST statement's value the exit
  // code — declarations don't carry one (a bare `x=5` exits 0).
  const body = program.body || [];
  const last = body[body.length - 1];
  // ExpressionStatement → its value is the success flag; control-flow
  // statements (for/while/if/...) carry the exit code in sh2.lastExit.
  const lastIsExpr = last && last.type === "ExpressionStatement";
  // When the last statement is an ExpressionStatement it is wrapped in
  // `return (...)`, emitting the full body here too would run it TWICE
  // (debashing a single `echo hi` into one statement used to print
  // twice). bodyJs carries everything BEFORE the last statement.
  const bodyJs = (lastIsExpr
    ? (body.length > 1 ? await estreeToJs({ type: "Program", body: body.slice(0, -1) }) : "")
    : await estreeToJs({ type: "Program", body })) + "\n";
  const lastJs = lastIsExpr
    ? "return (" + (await estreeToJs({ type: "Program", body: [last] })).replace(/;\s*$/, "") + ");\n"
    : "return sh2.lastExit;\n";
  const js = bodyJs + lastJs;
  // eval + harvest + exit-code mapping — the SHARED shellcore helper
  return evalProgramOnOtRt(js, { lineAssigned, positional: srcArgs }, shellCtx);
}



// ─── real coreutils (uutils wasm) ────────────────────────────────
// uutils.org's Rust coreutils compiled to wasm32-wasi (CORS-open, but
// vendored in www/wasm-bin/ like every other wasm tool). The multi-call
// uutils.wasm dispatches on argv[0], so a bare command this shell
// doesn't ship runs it with argv[0] = the command name (sed ships as its
// own single-call wasm and resolves normally once staged).

// cc / cproc / tcc — the compilers, intercepted before resolution (the
// shared runSegment's ctx.interceptCommand hook).
async function interceptCompilers(cmd, args, stdin, isLast, { outputRedirect, appendRedirect }) {
  // cc — the REAL C compiler: cproc (wasm32-wasi) → QBE IR → qbe2wasm.
  // Intercepted before resolveCommand (bare `cc` has no fetch-based
  // auto-load in node). cproc reads the source from the WASI sandbox
  // and writes QBE IR to stdout; libc calls resolve to the env runtime.
  if ((cmd === "cc" || cmd === "compiler") && args.length > 0 && !cmd.includes("/")) {
    const resolve = (p) => (p && p.startsWith("/") ? p : fs._resolve(p));
    let ccOutput = null, srcFile = null, ccIR = false;
    if (args[0] === "-o" && args[1]) { ccOutput = resolve(args[1]); srcFile = resolve(args[2]); }
    else if (args[0] === "-S") { ccIR = true; srcFile = resolve(args[1]); }
    else if (args[0].endsWith(".wasm") && args[1]) { ccOutput = resolve(args[0]); srcFile = resolve(args[1]); }
    else { ccOutput = resolve("a.wasm"); srcFile = resolve(args[0]); }
    if (!srcFile) { process.stderr.write("cc: missing source file\n"); return { ok: false, code: 1, output: "" }; }
    let original;
    try { original = await fs.read(srcFile); }
    catch (e) { process.stderr.write(`cc: cannot read ${srcFile}: ${e.message}\n`); return { ok: false, code: 1, output: "" }; }
    const prepped = preprocessC(original);
    const tmpSrc = "/tmp/cc-src-" + (ccCounter++) + ".c";
    await fs.write(tmpSrc, prepped);
    const cprocPath = "/usr/bin/cproc.wasm";
    if (!(await fs.stat(cprocPath).catch(() => null))) {
      const { readFileSync } = await import("node:fs");
      await fs.writeBlob(cprocPath, new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));
    }
    await wasmRunner.run(cprocPath, ["cproc-qbe", "-t", "wasm64", tmpSrc]);
    const qbeErr = wasmRunner.getStderr();
    if (wasmRunner.getExitCode() !== 0) {
      process.stderr.write(qbeErr || `cc: cproc failed (exit ${wasmRunner.getExitCode()})\n`);
      return { ok: false, code: wasmRunner.getExitCode(), output: "" };
    }
    const ir = wasmRunner.getStdout();
    if (ccIR) {
      // -S: the QBE IR is the "assembly"; > file redirects it
      if (outputRedirect) await writeOut(outputRedirect, ir, appendRedirect);
      else process.stdout.write(ir);
      return { ok: true, code: 0, output: ir };
    }
    try {
      const { qbe2wasm } = await import("./qbe2wasm.js");
      const bytes = qbe2wasm(ir, {});
      await fs.writeBlob(ccOutput, new Blob([bytes], { type: "application/wasm" }));
      wasmRunner.invalidate(ccOutput); // recompiled in place — drop the stale module
      const ccMsg = `${ccOutput}: ${bytes.length} bytes\n`;
      if (outputRedirect) await writeOut(outputRedirect, ccMsg, appendRedirect);
      else process.stdout.write(ccMsg);
      return { ok: true, code: 0, output: "" };
    } catch (e) {
      process.stderr.write(`cc: qbe2wasm: ${e.message}\n`);
      return { ok: false, code: 1, output: "" };
    }
  }

  // cproc — the raw C frontend (C → QBE IR), like `cc -S` with cproc's
  // own CLI. Same preprocessing as cc (strip #lines, inject the libc
  // decls) and the wasm64 target, so `cproc t.c` emits IR qbe2wasm can
  // compile — or writes it with `cproc -o out.qbe t.c`.
  if (cmd === "cproc" && args.length > 0 && !cmd.includes("/")) {
    const resolve = (p) => (p && p.startsWith("/") ? p : fs._resolve(p));
    let srcFile = null, cprocOut = null;
    if (args[0] === "-o" && args[1]) { cprocOut = resolve(args[1]); srcFile = resolve(args[2]); }
    else { srcFile = resolve(args[0]); }
    if (!srcFile) { process.stderr.write("cproc: missing source file\n"); return { ok: false, code: 1, output: "" }; }
    let original;
    try { original = await fs.read(srcFile); }
    catch (e) { process.stderr.write(`cproc: cannot read ${srcFile}: ${e.message}\n`); return { ok: false, code: 1, output: "" }; }
    const prepped = preprocessC(original);
    const tmpSrc = "/tmp/cc-src-" + (ccCounter++) + ".c";
    await fs.write(tmpSrc, prepped);
    const cprocPath = "/usr/bin/cproc.wasm";
    if (!(await fs.stat(cprocPath).catch(() => null))) {
      const { readFileSync } = await import("node:fs");
      await fs.writeBlob(cprocPath, new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));
    }
    await wasmRunner.run(cprocPath, ["cproc-qbe", "-t", "wasm64", tmpSrc]);
    const qbeErr = wasmRunner.getStderr();
    if (wasmRunner.getExitCode() !== 0) {
      process.stderr.write(qbeErr || `cproc: failed (exit ${wasmRunner.getExitCode()})\n`);
      return { ok: false, code: wasmRunner.getExitCode(), output: "" };
    }
    const ir = wasmRunner.getStdout();
    if (outputRedirect) { await writeOut(outputRedirect, ir, appendRedirect); }
    else if (cprocOut) { await fs.write(cprocOut, ir); process.stdout.write(`${cprocOut}: ${ir.length} bytes\n`); }
    else process.stdout.write(ir);
    return { ok: true, code: 0, output: ir };
  }

  // tcc — the REAL Tiny C Compiler (wasm32-wasi, wasm32 code target).
  // Compiles C to a wasm module: tcc -c prog.c -o prog.wasm. The binary
  // and the libc headers (staged into /tmp/tcc/include) come from
  // wasm-bin/ via the shared src/tcc.js helper. Intercepted before
  // resolveCommand (the CLI has no server, so no fetch-based auto-load).
  if (cmd === "tcc" && !cmd.includes("/")) {
    const { runTcc } = await import("./tcc.js");
    const { readFile } = await import("node:fs/promises");
    const fetchBundle = async (rel) => {
      const buf = await readFile(new URL(`../www/${rel}`, import.meta.url));
      return new Uint8Array(buf);
    };
    // runTcc normalizes to `-c <src> -o a.wasm` (cc convention).
    try {
      const r = await runTcc({ vfs: fs, runner: wasmRunner, args, fetchBundle });
      const out = wasmRunner.getStdout(), err = wasmRunner.getStderr();
      const code = wasmRunner.getExitCode();
      if (code === 0 && !args.some((a) => a === "-o")) {
        const outFile = fs._resolve("a.wasm");
        const st = await fs.stat(outFile).catch(() => null);
        process.stdout.write(`${outFile}: ${st ? st.size : 0} bytes\n`);
      }
      if (out) process.stdout.write(out);
      if (err) process.stderr.write(err);
      return { ok: code === 0, code, output: out };
    } catch (e) {
      process.stderr.write(`tcc: ${e.message}\n`);
      return { ok: false, code: 1, output: "" };
    }
  }

  // python — MicroPython engine (reactor, src/py.js): REPL, -c, script
  // files and stdin. Intercepted before resolveCommand so it never
  // auto-loads python.wasm.
  if (cmd === "python" && !cmd.includes("/")) {
    return await runPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect);
  }
  // /bin/bash — the REAL bash 5.3 (wasm32-emscripten), unlike the bare
  // `bash` builtin which transpiles bash → JS. Runs -c / a VFS script /
  // stdin through the actual bash binary.
  if (cmd === "/bin/bash") {
    try {
      const { runRealBash } = await import("./realbash.js");
      const hostRun = async (cmdline, stdinIn, bashCwd) => {
        const prevCwd = fs.cwd;
        if (bashCwd) { try { fs.cwd = bashCwd; } catch {} }
        // NB: the output is NOT written here — runRealBash appends it to
        // bash's own stdout so the transcript stays in execution order.
        const h = await runNestedCommand(cmdline, stdinIn || "");
        if (bashCwd) { try { fs.cwd = prevCwd; } catch {} }
        return h;
      };
      let script = "";
      if (args[0] === "-c") script = args.slice(1).join(" ");
      else if (args.length && !args[0].startsWith("-")) {
        try { script = await fs.read(args[0]); } catch { script = args[0]; }
      } else if (stdin) script = pipeText(stdin);
      if (!script.trim()) {
        process.stderr.write("/bin/bash: the real bash 5.3 — give it a script: /bin/bash -c 'echo hi' · /bin/bash script.sh · cat x | /bin/bash — sees /tmp and /home (writes sync back). Top-level external commands run synchronously in the shell (correct order, $? and stdin redirects); pipelines/subshells still need a real fork — those fail. `web <cmd>` also runs in the shell. Bare `bash` is the interactive builtin\n");
        return { ok: false, code: 2, output: "" };
      }
      const r = await runRealBash(script, { hostRun });
      if (outputRedirect) await writeOut(outputRedirect, r.out, appendRedirect);
      else if (isLast) { if (r.out) process.stdout.write(r.out); }
      else output = r.out;
      if (r.err) process.stderr.write(r.err);
      return { ok: r.code === 0, code: r.code, output: r.out };
    } catch (e) {
      process.stderr.write("/bin/bash: " + (e && e.message ? e.message : e) + "\n");
      return { ok: false, code: 1, output: "" };
    }
  }
  // perl — bare `perl` with no script/stdin opens the interactive REPL
  // (the /bin perl command handles -e / script / stdin as before).
  if (cmd === "perl" && !cmd.includes("/") && args.length === 0 && !pipeText(stdin).trim()) {
    enterPerlRepl();
    return { ok: true, code: 0, output: "" };
  }

  return null;
}

async function runSegment(segmentText, stdin, isLast) {
  return sharedRunSegment(segmentText, stdin, isLast, null, shellCtx);
}

// Split a line into conditional segments on `&&` and `||`, respecting
// quotes and backslash escapes (a `\&&` outside quotes is a literal
// ampersand, not an operator). Returns { text, op } parts where `op`
// is the operator preceding the part ('&&' or '||'), or null for the
// first part. A lone `&` is handled by splitBgList before this runs.

// Run one pipeline (`|`-separated commands), feeding each command's
// stdout to the next command's stdin. Returns the pipeline's exit
// status: the first failing command's status, else the last one's.
// python — run through the MicroPython reactor (src/py.js). The engine
// is a singleton, so state persists across lines and invocations.
async function runPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect) {
  return sharedRunPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect, shellCtx);
}


// Run a nested command line from generated JS (pipelines and command
// substitution inside a `bash` script) through the shell itself, and
// return its captured stdout plus exit status. This is what rt.exec /
// rt.pipe / rt.pipeCond in the generated JS call: sh2perl shells out
// to 'bash -c "..."' for pipes, and we route that back through the
// shell's own pipeline machinery.
async function runNestedCommand(cmdLine, stdin = "") {
  let captured = "";
  let capturedErr = "";
  const origWrite = process.stdout.write;
  const origErrWrite = process.stderr.write;
  const capOut = (chunk) => {
    // Capture while we're in the current write chain. The suppression
    // guard wraps us during nested runs (bash → runNestedCommand →
    // runSegment), so walk __wraps links — only forward to the original
    // writer when an UNRELATED capture (a background job's) owns the
    // output.
    let w = process.stdout.write;
    let mine = w === capOut;
    while (!mine && w && typeof w.__wraps === "function") {
      w = w.__wraps;
      mine = w === capOut;
    }
    if (mine) {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }
    return origWrite.call(process.stdout, chunk);
  };
  const capErr = (chunk) => {
    let w = process.stderr.write;
    let mine = w === capErr;
    while (!mine && w && typeof w.__wraps === "function") {
      w = w.__wraps;
      mine = w === capErr;
    }
    if (mine) {
      capturedErr += chunk;
      return true;
    }
    return origErrWrite.call(process.stderr, chunk);
  };
  process.stdout.write = capOut;
  process.stderr.write = capErr;
  let code = 0;
  try {
    code = (await handleLine(cmdLine, stdin)) ?? 0;
  } finally {
    if (process.stdout.write === capOut) process.stdout.write = origWrite;
    if (process.stderr.write === capErr) process.stderr.write = origErrWrite;
  }
  return { out: captured, err: capturedErr, code };
}

function getJobScheduler() {
  // One shared scheduler per shell process/page, so at/cron commands and
  // the boot-time restore all see the same job queue. Jobs run through
  // runNestedCommand; cron jobs persist to /home/.jtshcron.
  if (!globalThis.__jtshJobs) {
    globalThis.__jtshJobs = createJobScheduler({
      fs,
      runLine: (cmd) => runNestedCommand(cmd),
      stdout: process.stdout,
      stderr: process.stderr,
      storagePath: "/home/.jtshcron",
    });
  }
  return globalThis.__jtshJobs;
}

// Background jobs (`cmd &`): one shared table per shell. Output goes
// straight to the terminal (live); the completion notice is printed by
// onUpdate. See createBgJobs in src/jobs.js.
function getBgJobs() {
  if (!globalThis.__jtshBgJobs) {
    globalThis.__jtshBgJobs = createBgJobs({
      runLine: async (job) => (await runPipeline(job.cmd)) ?? 0,
      onUpdate: (job) => {
        if (job.running || job.notified) return;
        job.notified = true;
        const status = job.killed ? "Killed" : job.code === 0 ? "Done" : `Failed (exit ${job.code})`;
        process.stdout.write(`[${job.id}]+  ${status.padEnd(18)} ${job.cmd}\n`);
      },
    });
  }
  return globalThis.__jtshBgJobs;
}

// Split a line into background segments on a single `&` (respecting
// quotes and backslash escapes). `&&` is the conditional operator and
// stays inside a segment (handled by splitConditionals later). Returns
// { text, bg } parts: bg=true when the segment was terminated by `&`,
// meaning it runs as a background job (`cmd & cmd2` → cmd bg, cmd2 fg).


// Run one conditional list (`&&` / `||`-joined pipelines) — the
// foreground part of a line, or the body of a background job.

// ─── Startup config (~/.jtshrc) ─────────────────────────────
// Like a Unix shell's rc file (.bashrc / .zshrc), $HOME/.jtshrc
// is read at startup and each non-comment line is run as a shell
// command. Use it for persistent environment variables and setup:
//
//   # sample ~/.jtshrc  (i.e. /home/.jtshrc)
//   export EDITOR=edit
//   echo "Welcome back!"
//
// Lines starting with # are comments; a missing file is not an
// error (bash skips a nonexistent .bashrc the same way).
async function loadConfig() {
  const home = env.HOME.replace(/\/+$/, "") || "/";
  // .jtshrc is the name now; read a pre-rebrand .tinyshrc as a fallback
  // so existing users keep their config.
  let configPath = home + "/.jtshrc";
  let content;
  try {
    content = await fs.read(configPath);
  } catch {
    try {
      configPath = home + "/.tinyshrc";
      content = await fs.read(configPath);
    } catch {
      return; // no config file — not an error
    }
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    await handleLine(trimmed);
  }
}

// ─── History expansion: !!, !N, !-N, !string, !?s, !$ — bash-style ──
// Expanded at the interactive prompt BEFORE the line is parsed, like
// bash: the expansion is echoed first (`$ !!` prints the replayed line),
// and an unknown designator errors with "<designator>: event not found".
// Single-quoted regions and `\!` are literal. `history` is the command
// list, most recent LAST.
function expandHistory(line, history) {
  if (!line.includes("!")) return { line, note: null, err: null };
  const n = history.length;
  const prev = () => (n ? history[n - 1] : null);
  const startsWith = (s) => {
    for (let i = n - 1; i >= 0; i--) if (history[i].startsWith(s)) return history[i];
    return null;
  };
  const contains = (s) => {
    for (let i = n - 1; i >= 0; i--) if (history[i].includes(s)) return history[i];
    return null;
  };
  let out = "";
  let i = 0;
  let inSingle = false;
  let used = false;
  let bad = null;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") { inSingle = !inSingle; out += ch; i++; continue; }
    if (inSingle) { out += ch; i++; continue; }
    if (ch === "\\" && line[i + 1] === "!") { out += "!"; i += 2; continue; }
    if (ch !== "!") { out += ch; i++; continue; }
    const rest = line.slice(i + 1);
    let ev = null, label = "!";
    if (rest[0] === "!") { ev = prev(); label = "!!"; i += 2; }
    else if (/^\d+/.test(rest)) { const m = /^(\d+)/.exec(rest); ev = (n && parseInt(m[1], 10) >= 1 && parseInt(m[1], 10) <= n) ? history[parseInt(m[1], 10) - 1] : null; label = "!" + m[1]; i += 1 + m[1].length; }
    else if (/^-\d+/.test(rest)) { const m = /^-(\d+)/.exec(rest); const k = parseInt(m[1], 10); ev = (n && k >= 1 && k <= n) ? history[n - k] : null; label = "!" + m[0]; i += 1 + m[0].length; }
    else if (rest[0] === "$") { const p = prev(); ev = p ? p.split(/\s+/).filter(Boolean).pop() : null; label = "!$"; i += 2; }
    else if (rest.startsWith("?")) {
      const end = rest.indexOf("?", 1);
      const needle = end > 0 ? rest.slice(1, end) : rest.slice(1);
      ev = contains(needle); label = "!?" + needle + (end > 0 ? "?" : ""); i += 1 + (end > 0 ? end : rest.length);
    }
    else if (/^[A-Za-z0-9_./-]/.test(rest)) { const m = /^([A-Za-z0-9_./-]+)/.exec(rest); ev = startsWith(m[1]); label = "!" + m[1]; i += 1 + m[1].length; }
    else { out += ch; i++; continue; }   // `! `, trailing `!` — literal
    if (ev === null || ev === undefined) { bad = label + ": event not found"; break; }
    out += String(ev);
    used = true;
  }
  if (bad) return { line, note: null, err: bad };
  return { line: out, note: used ? line : null, err: null };
}

// ─── Tab Completion ─────────────────────────────────────────────
// Complete the word under the cursor, readline callback-style
// (fs.* is async and some Node builds ignore Promise-returning
// completers, so we call callback(null, [matches, word]) when done):
//
//   word contains "/"  → partial path completion. The last segment is
//     completed against the directory listing, so
//       /mount/github/g<Tab> → /mount/github/gmatht/
//     (or the shared prefix of all matches; a second Tab lists them).
//   otherwise            → command completion: builtins plus .js/.mjs/
//     .wasm executables found in $PATH (/bin:/usr/bin).
function tabComplete(line, callback) {
  const wordStart = Math.max(line.lastIndexOf(" ") + 1, 0);
  const word = line.slice(wordStart);
  if (!word) return callback(null, [[], word]);

  const finish = (matches) => {
    callback(null, [[...new Set(matches)].sort(), word]);
  };

  if (word.includes("/")) {
    // Partial path — list the directory and filter by the typed prefix
    const lastSlash = word.lastIndexOf("/");
    const dir = word.slice(0, lastSlash + 1);
    const filePrefix = word.slice(lastSlash + 1);
    (async () => {
      try {
        const resolvedDir = dir === "/" ? "/" : fs._resolve(dir.replace(/\/$/, ""));
        const entries = await fs.list(resolvedDir);
        finish(entries
          .filter((e) => e.startsWith(filePrefix))
          .map((e) => line.slice(0, wordStart) + dir + e));
      } catch {
        // Directory doesn't exist (or a remote backend hiccuped) — no matches
        finish([]);
      }
    })();
    return;
  }

  // Command completion: builtins + executables on $PATH
  const matches = Object.keys(builtins)
    .filter((name) => name.startsWith(word))
    .map((name) => line.slice(0, wordStart) + name);
  (async () => {
    try {
      for (const dir of env.PATH.split(":").filter(Boolean)) {
        const entries = await fs.list(dir);
        for (const e of entries) {
          const name = e.replace(/\/$/, "").replace(/\.(js|mjs|wasm)$/i, "");
          const full = line.slice(0, wordStart) + name;
          if (name.startsWith(word) && !matches.includes(full)) matches.push(full);
        }
      }
    } catch {
      // Some PATH dirs don't exist — skip them
    }
    finish(matches);
  })();
}

// ─── Main ───────────────────────────────────────────────────────

// ─── Interactive REPLs (reactor-based — python via src/py.js, perl
// via zeroperl; both state-preserving, no worker / SharedArrayBuffer).
const replState = { active: false, mode: null, perl: null, perlReady: null,
  perlSession: [], perlOut: "", perlMarker: "",
  bashSession: [], bashOut: "", bashMarker: "",
  cmdSession: [], cmdOut: "", cmdMarker: "" };
let shellHistory = [];  // the shell's readline history while a REPL owns it
const suState = { prev: null };  // previous user context, for `su jtsh`

// Prompt shows the current user — su'd users appear as nobody:/home/nobody$
function shellPrompt() {
  const user = env.USER && env.USER !== "jtsh" ? env.USER : "jtsh";
  return `${user}:${fs.view ? fs.view(fs.cwd) : fs.cwd}$ `;
}

function enterPythonRepl() {
  if (!process.stdin.isTTY) { process.stderr.write("python: REPL requires an interactive terminal\n"); return; }
  replState.active = true;
  replState.mode = "python";
  shellHistory = rl.history.slice();
  rl.history = [];   // the REPL gets its own readline history (Up/Down)
  process.stdout.write("MicroPython REPL — state persists per line · exit() or Ctrl-D to leave\n");
  rl.setPrompt(">>> ");
  rl.prompt();
}

function enterPerlRepl() {
  if (!process.stdin.isTTY) { process.stderr.write("perl: REPL requires an interactive terminal\n"); return; }
  replState.active = true;
  replState.mode = "perl";
  shellHistory = rl.history.slice();
  rl.history = [];   // the REPL gets its own readline history (Up/Down)
  process.stdout.write("Perl REPL (zeroperl) — state persists per line · exit or Ctrl-D to leave\n");
  rl.setPrompt("perl> ");
  rl.prompt();
  replState.perlSession = [];
  replState.perlMarker = "__perl_repl_" + Date.now() + "_" +
    Math.floor(Math.random() * 1e9) + "__";
  replState.perlReady = (async () => {
    try {
      const mod = await import("@6over3/zeroperl-ts");
      const perl = await mod.ZeroPerl.create({
        env: env || {},
        fileSystem: null,
        stdout: (d) => { replState.perlOut += typeof d === "string" ? d : new TextDecoder().decode(d); },
        stderr: (d) => process.stderr.write(typeof d === "string" ? d : new TextDecoder().decode(d)),
      });
      replState.perl = perl;
    } catch (e) {
      process.stderr.write(`perl: ${e.message}\n`);
      exitRepl();
    }
  })();
}

function enterBashRepl() {
  if (!process.stdin.isTTY) { process.stderr.write("bash: REPL requires an interactive terminal\n"); return; }
  replState.active = true;
  replState.mode = "bash";
  shellHistory = rl.history.slice();
  rl.history = [];
  process.stdout.write("bash REPL — the jtsh BUILTIN (transpiles bash → JS; not /bin/bash — that's the real bash 5.3 wasm). State persists per line · exit or Ctrl-D to leave\n");
  rl.setPrompt("bash> ");
  rl.prompt();
  replState.bashSession = [];
  replState.bashMarker = "__bash_repl_" + Date.now() + "_" +
    Math.floor(Math.random() * 1e9) + "__";
}

function enterCmdRepl() {
  if (!process.stdin.isTTY) { process.stderr.write("cmd.exe: REPL requires an interactive terminal\n"); return; }
  replState.active = true;
  replState.mode = "cmd";
  shellHistory = rl.history.slice();
  rl.history = [];
  process.stdout.write("cmd.exe REPL — Windows batch, transpiled to JS (bat-sh-go → A1 → estree). State persists per line · exit or Ctrl-D to leave\n");
  rl.setPrompt("cmd> ");
  rl.prompt();
  replState.cmdSession = [];
  replState.cmdMarker = "__cmd_repl_" + Date.now() + "_" +
    Math.floor(Math.random() * 1e9) + "__";
}

function exitRepl() {
  if (!replState.active) return;
  const mode = replState.mode;
  if (replState.perl) { try { replState.perl.shutdown(); } catch (e) {} }
  replState.active = false;
  replState.mode = null;
  replState.perl = null;
  replState.perlReady = null;
  const label = mode === "perl" ? "Perl" : mode === "bash" ? "Bash" : mode === "cmd" ? "cmd.exe" : "Python";
  process.stdout.write(`\nLeaving ${label} REPL.\n`);
  rl.history = shellHistory;  // give the shell its history back
  rl.setPrompt(shellPrompt());
  // EOF can close readline before a queued `exit` line (or the close
  // handler) reaches here — prompt() on a closed interface throws
  // ERR_USE_AFTER_CLOSE and crashes the shell. Guard it: the queued
  // line tasks still drain and the process exits when the loop empties.
  if (!rl.closed) rl.prompt();
}

async function runReplLine(line) {
  return sharedRunReplLine(line, shellCtx);
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: shellPrompt(),
  terminal: process.stdin.isTTY,
  completer: tabComplete,
});

if (process.stdin.isTTY) {
  // Read the user's ~/.jtshrc before the first prompt so exports
  // and setup commands are already in effect (like bash and .bashrc).
  await loadConfig();
  await getJobScheduler().restore();  // re-arm persisted cron jobs
  // readline fires 'line' without awaiting the handler, so fast typing
  // (or a piped stream) would run commands concurrently — fatal for the
  // perl REPL, which shares one interpreter and an output buffer across
  // lines. Serialize everything through a queue, like the browser shell.
  let lineQueue = Promise.resolve();
  rl.on("line", (line) => {
    lineQueue = lineQueue.then(async () => {
      if (replState.active) { await runReplLine(line); return; }
      // bash-style history expansion (!! / !N / !-N / !string / !?s / !$)
      const exp = expandHistory(line, rl.history);
      if (exp.err) { process.stderr.write(`jtsh: ${exp.err}\n`); return; }
      if (exp.note) process.stdout.write(exp.note + "\n");
      await runInterruptible(handleLine(exp.line));
      rl.setPrompt(shellPrompt());
      rl.prompt();
    }).catch((e) => {
      process.stderr.write(`jtsh: ${e && e.message ? e.message : e}\n`);
    });
  });

  // Ctrl+C: registering a SIGINT listener takes over from readline's
  // default (which would close the shell). While a command runs we
  // abort it (exit 130); at the prompt we cancel the current line.
  rl.on("SIGINT", () => {
    process.stdout.write("^C\n");
    if (replState.active) {
      process.stdout.write("KeyboardInterrupt\n");
      rl.setPrompt(replState.mode === "perl" ? "perl> " : replState.mode === "bash" ? "bash> " : replState.mode === "cmd" ? "cmd> " : ">>> ");
      rl.prompt();
      return;
    }
    if (running) {
      if (interruptSignal) interruptSignal();
      return;
    }
    // Cancel the partially typed line and redraw the prompt.
    rl.write(null, { ctrl: true, name: "u" });
    rl.setPrompt(shellPrompt());
    rl.prompt();
  });

  rl.on("close", () => {
    if (replState.active) { exitRepl(); return; }
    process.stdout.write("\n");
    process.exit(0);
  });
  rl.prompt();
} else {
  // Batch mode — process each line sequentially using async iterator
  for await (const line of rl) {
    await handleLine(line);
  }
  process.exit(0);
}
