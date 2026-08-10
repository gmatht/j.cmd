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
import { a1LiteralValue, syncOtVarsFromStore, runSourceContent as sharedRunSourceContent } from "./shellcore/transpile.js";
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
const pipeText = (d) => (typeof d === "string" ? d : new TextDecoder().decode(d));
const pipeBytes = (d) => (typeof d === "string" ? new TextEncoder().encode(d) : d);
const joinOut = (chunks) => {
  if (chunks.length === 0) return "";
  if (chunks.every((c) => typeof c === "string")) return chunks.join("");
  const parts = chunks.map(pipeBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
// Write pipe data to a VFS file: bytes go through writeBlob (binary
// safe), text through fs.write.
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

// ─── Ctrl+C (SIGINT) interruption ──────────────────────────────
// A real shell delivers SIGINT to the foreground process; here that
// means: abort the running command and return to the prompt with
// status 130 (128 + SIGINT). JS can't hard-kill an in-flight async
// function, so we race the command against an interrupt signal and
// abandon it — remaining output from the aborted command is dropped
// (suppressOutput) until a newer command takes over the terminal.
// At an idle prompt, Ctrl+C cancels the current input line.
class InterruptError extends Error {
  constructor() { super("interrupt"); this.name = "InterruptError"; }
}
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
  get stdin() { return stdinBuffer; },
  get isTTY() { return Boolean(process.stdin.isTTY); },
  runNestedCommand,
  findCommand: (name) => shellResolve(shellCtx, name),
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
  // state/backend accessors the shared runSourceContent weaves through
  getOtVars: () => otVars,
  goRunner,
  fetchBusyboxBytes: async () => {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(new URL("../www/wasm-bin/otranspiler-busybox.wasm", import.meta.url)));
  },
  evalProgram: (program, lineAssigned, srcArgs) => runEstreeProgram(program, lineAssigned, srcArgs),
  wasmRunner,
  goCmd,
  isPrivilegedUser,
  getBgJobs,
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
function splitPipe(line) {
  const segments = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      if (i + 1 < line.length) { cur += line[i + 1]; i++; }
      continue;
    }
    if (ch === "'") { inSingle = true; cur += ch; continue; }
    if (ch === '"') { inDouble = true; cur += ch; continue; }
    if (ch === "|") { segments.push(cur); cur = ""; continue; }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

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
function looksLikeBash(text) {
  // strip ONLY single quotes — double quotes are not inert: ${…} /
  // $(…) inside them is real bash (`echo "${a[1]}"` must route to the
  // transpiler, while `echo 'a;b'` is one literal argument)
  const unquoted = String(text).replace(/'(?:[^'\\]|\\.)*'/g, "");
  // a leading `name=value` (no space before `=`) is an assignment, not a
  // command — bash always parses it that way (`a = 5` stays a command
  // named `a` because the tokenizer splits on whitespace)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted)) return true;
  if (/\b(for|while|until|if|case|select|function)\b/.test(unquoted)) return true;
  if (/[;{}]/.test(unquoted)) return true;                 // `;` separator, `{ … }` group
  if (/\$\(|\[\[/.test(unquoted)) return true;          // $(…) / [[ ]]
  if (/\[[^\]]*\]/.test(unquoted)) return true;           // [ … ] test
  return /\$\{/.test(unquoted);
}

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
  if (otRt) return;
  const { createSh2Runtime } = await import("./sh2runtime.js");
  const out = { write: (s) => { if (s) process.stdout.write(s); } };
  const err = { write: (s) => { if (s) process.stderr.write(s); } };
  // The native estree backend writes through process.stdout.write and
  // reads process.env/argv — provide a shim (in the browser there is no
  // node process at all).
  otProc = {
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
  otRt = createSh2Runtime({
    fs, env, shellExec: runNestedCommand,
    stdout: out, stderr: err, args: [], argv0: "sh",
  });
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
  const { args = [], argv0 = "script", runCmd = runNestedCommand } = opts;
  const { getOtranspilerl } = await import("./otranspilerl.js");
  const lib = await getOtranspilerl();
  const { estreeToJs, keepVariables } = await import("./estree.js");
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
  const { createSh2Runtime } = await import("./sh2runtime.js");
  const out = { write: (s) => { if (s) process.stdout.write(s); } };
  const err = { write: (s) => { if (s) process.stderr.write(s); } };
  const rt = createSh2Runtime({ fs, env, shellExec: runCmd, stdout: out, stderr: err, args, argv0 });
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

async function runViaTranspiler(segmentText, stdin) {
  const { getOtranspilerl } = await import("./otranspilerl.js");
  const lib = await getOtranspilerl();
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
  const lineCaptured = new Set();   // names a VALUE was captured for this line
  try {
    const a1 = JSON.parse(lib.shir(src));
    for (const st of a1.stmts || []) {
      if (st && st.type === "Assign" && st.targets && st.targets[0]) {
        const t = st.targets[0];
        if (t.var && !(t.indices && t.indices.length)) {
          lineAssigned.add(t.var);
          const val = a1LiteralValue(st.expr);
          if (val !== undefined) { otVars.set(t.var, val); lineCaptured.add(t.var); }
        }
      }
    }
  } catch {}
  return runEstreeProgram(program, lineAssigned, []);
}

async function runEstreeProgram(program, lineAssigned, srcArgs) {
  const lineCaptured = new Set();   // names a VALUE was captured for this run
  const { estreeToJs, keepVariables } = await import("./estree.js");
  // KEEP_VARIABLES: route known array state through the persistent
  // runtime store (bare `a[1]`/`a.length` reads → arrayIndex/arrayLen;
  // `let a = […]` declarations also sync to sh2.vars).
  keepVariables(program, [...otVars].filter(([, v]) => Array.isArray(v)).map(([k]) => k));
  // The estree convention: each statement's value is the command's
  // success flag (true/false). Make the LAST statement's value the exit
  // code — declarations don't carry one (a bare `x=5` exits 0).
  const body = program.body || [];
  const last = body[body.length - 1];
  // ExpressionStatement → its value is the success flag; control-flow
  // statements (for/while/if/…) carry the exit code in sh2.lastExit.
  const lastIsExpr = last && last.type === "ExpressionStatement";
  // When the last statement is an ExpressionStatement it is wrapped in
  // `return (…)` below — emitting the full body here too would run it
  // TWICE (debashing a single `echo hi` into one statement used to
  // print twice). bodyJs carries everything BEFORE the last statement.
  const bodyJs = (lastIsExpr
    ? (body.length > 1
        ? await estreeToJs({ type: "Program", body: body.slice(0, -1) })
        : "")
    : await estreeToJs({ type: "Program", body })) + "\n";
  const lastJs = lastIsExpr
    ? "return (" + (await estreeToJs({ type: "Program", body: [last] })).replace(/;\s*$/, "") + ");\n"
    : "return sh2.lastExit;\n";
  const js = bodyJs + lastJs;
  await ensureOtRuntime();  const fn = new Function("fs", "env", "process", "sh2", `
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
  try { otRt.sh2.stdin = stdinBuffer || ""; } catch {}   // pipe input → read_line()
  try { otRt.sh2.positional = (srcArgs && srcArgs.length ? srcArgs : getPositional()); } catch {}   // $1..$9
  try { otRt.sh2.argv0 = getArgv0(); } catch {}             // native $0 → transpiled
  let v;
  let exitCode = null;
  const beforeGlobals = new Set(Object.keys(globalThis));
  const beforeRtVars = new Set(Object.keys(otRt.sh2.vars));
  try {
    v = await fn(fs, env, otProc, otRt.sh2);
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
  // runtime store first: it holds the line's OWN writes (sh2.setVar /
  // sh2.setArray — the scalar re-assignment of an array name lands here,
  // not on globalThis). Skip untouched state: a pre-seeded name this
  // line didn't assign, OR whose value is still exactly the pre-seed
  // (the line's write went elsewhere — a bare `x = …` lands on
  // globalThis, which the next loop captures).
  const sameValue = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
    }
    return String(a) === String(b);
  };
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
  // names and positionals are synced separately (never overwrite them).
  for (const [k, v] of otVars) {
    if (isReadonly(k)) continue;
    try { env[k] = Array.isArray(v) ? v.join(" ") : String(v); } catch {}
  }
  try { setPositional(otRt.sh2.positional, otRt.sh2.argv0); } catch {}   // transpiled set -- → native
  if (exitCode !== null) { setShellStatus(exitCode); return exitCode; }  // `exit N`
  // The estree convention: each statement's value is the command's
  // success flag (true/false) — assignments carry their value but exit 0.
  // A bare C-function call (`sum_first "$(addr a)" 3`) runs through
  // sh2.exec, whose boolean masks the C return value — the runtime
  // already records it as sh2.lastExit (`return 60` → 60), so a failing
  // (non-zero) call reports the C return as $?, like the user docs say.
  const exitVal = v === false ? (Number(otRt.sh2.lastExit) || 1) : 0;
  setShellStatus(exitVal);   // transpiled $? → native
  return exitVal;
}



// ─── real coreutils (uutils wasm) ────────────────────────────────
// uutils.org's Rust coreutils compiled to wasm32-wasi (CORS-open, but
// vendored in www/wasm-bin/ like every other wasm tool). The multi-call
// uutils.wasm dispatches on argv[0], so a bare command this shell
// doesn't ship runs it with argv[0] = the command name (sed ships as its
// own single-call wasm and resolves normally once staged).
const UUTILS_COMMANDS = new Set(["arch","b2sum","base32","base64","basename","basenc","cat","cksum","comm","cp","csplit","cut","date","dd","dir","dircolors","dirname","echo","expand","factor","fmt","fold","head","join","link","ln","ls","md5sum","mkdir","mktemp","mv","nl","nproc","numfmt","od","paste","pathchk","pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shred","shuf","sleep","sort","split","sum","tail","tee","touch","tr","truncate","tsort","tty","uname","unexpand","uniq","unlink","vdir","wc","sed"]);

let uutilsWasmPromise = null;
function ensureUutilsWasm() {
  uutilsWasmPromise ??= (async () => {
    // stage wasm-bin/*.wasm into the VFS (browser auto-load does this
    // for WASM_BIN; node stages on demand from the repo copy)
    for (const name of ["uutils.wasm", "sed.wasm"]) {
      const path = "/usr/bin/" + name;
      const st = await fs.stat(path).catch(() => null);
      if (st) continue;
      let bytes;
      if (typeof process !== "undefined" && process.versions && process.versions.node) {
        const { readFile } = await import("node:fs/promises");
        bytes = new Uint8Array(await readFile(new URL("../www/wasm-bin/" + name, import.meta.url)));
      } else {
        const resp = await fetch("wasm-bin/" + name);
        if (!resp.ok) throw new Error("uutils wasm fetch " + resp.status);
        bytes = new Uint8Array(await resp.arrayBuffer());
      }
      await fs.writeBlob(path, new Blob([bytes]));
    }
    return "/usr/bin/uutils.wasm";
  })();
  return uutilsWasmPromise;
}

async function runSegment(segmentText, stdin, isLast) {
  let tokens;
  try {
    tokens = tokenize(segmentText);
  } catch (e) {
    process.stderr.write(`jtsh: ${e.message}\n`);
    return { ok: false, code: 2, output: "" };
  }
  if (tokens.length === 0) return { ok: false, code: 2, output: "" };
  let cmd = tokens[0];
  const args = tokens.slice(1);
  // Mobile keyboards auto-capitalize the first letter — tolerate `Ls`
  // for `ls` by folding a bare name's first letter (exact wins, paths
  // are untouched). The folded name flows through intercepts, hints,
  // resolution and /proc alike.
  if (!cmd.includes("/") && /^[A-Z]/.test(cmd)) {
    const folded = cmd[0].toLowerCase() + cmd.slice(1);
    if (folded !== cmd) cmd = folded;
  }

  let outputRedirect = null;
  let appendRedirect = false;
  let redirectIndex = args.indexOf(">>");
  if (redirectIndex === -1) redirectIndex = args.indexOf(">");
  else appendRedirect = true;
  if (redirectIndex !== -1) {
    outputRedirect = args[redirectIndex + 1];
    args.splice(redirectIndex, 2);
  }

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

  // Handle redirection: > file
  let output = "";

  const resolved = await resolveCommand(cmd);
  if (resolved && resolved.type === "badpath") {
    // The path exists but can't be executed (a directory, or not a
    // .js/.mjs/.wasm file) — exit 126, POSIX "found but not executable".
    process.stderr.write(`${cmd}: ${resolved.err}\n`);
    return { ok: false, code: 126, output: "" };
  }
  if (!resolved) {
    // Last resort: a bash keyword / construct the tokenizer let through —
    // try the otranspilerl fallback before declaring "command not found"
    // (e.g. a `for …`/`if …` segment that reached this point without a
    // `;`, or a pipeline split that hid the bash syntax from the
    // conditional-list check).
    if (looksLikeBash(segmentText)) {
      try {
        const tcode = await runViaTranspiler(segmentText, stdin);
        return { ok: tcode === 0, code: tcode, output: "" };
      } catch { /* fall through to the normal not-found path */ }
    }
    // Real coreutils (uutils wasm): a bare command this shell doesn't
    // ship natively runs the multi-call uutils.wasm with argv[0] = the
    // command name (printf, sed, tr, cut, seq, sort, uniq, …).
    if (!cmd.includes("/") && UUTILS_COMMANDS.has(cmd)) {
      try {
        await ensureUutilsWasm();
        const uuPath = cmd === "sed" ? "/usr/bin/sed.wasm" : "/usr/bin/uutils.wasm";
        await wasmRunner.run(uuPath, [cmd, ...args], stdin);
        const uuOut = wasmRunner.getStdoutBytes();
        const uuErr = wasmRunner.getStderr();
        if (outputRedirect) {
          await writeOut(outputRedirect, uuOut.length ? uuOut : "", appendRedirect);
        } else if (isLast) {
          if (uuOut.length) process.stdout.write(pipeText(uuOut));
        } else {
          output = uuOut;
        }
        if (uuErr) process.stderr.write(uuErr);
        const uuCode = wasmRunner.getExitCode();
        if (uuCode !== 0) {
          process.stderr.write(`${cmd}: exited with code ${uuCode}\n`);
          return { ok: false, code: uuCode, output: "" };
        }
        return { ok: true, code: 0, output };
      } catch { /* fall through to the normal not-found path */ }
    }
    const hints = {
      "vi": "edit", "vim": "edit", "nano": "edit", "emacs": "edit",
      "more": "cat", "less": "cat",
      "cls": "clear", "quit": "exit", "q": "exit",
      "?": "help", "dir": "ls", "ll": "ls", "la": "ls",
      "chdir": "cd",
      "apt": "wasmer", "apt-get": "wasmer", "yum": "wasmer",
      "dnf": "wasmer", "brew": "wasmer", "pacman": "wasmer",
      "apk": "wasmer", "pip": "wasmer", "npm": "wasmer install",
      "umount": "unmount",
      "wasmer": "wasmer coming soon — WASM package manager for browser shell",
      "sh": "bash",
    };
    const hint = hints[cmd];
    if (hint) {
      process.stderr.write(`${cmd}: command not found — try "${hint}" instead\n`);
    } else {
      process.stderr.write(`${cmd}: command not found\n`);
    }
    return { ok: false, code: 127, output: "" };
  }

  // Register this command as a process in /proc/ so `ls /proc` shows
  // shell activity and /proc/<pid>/cmdline shows the command that ran.
  const pid = procfs.start(cmd, [cmd, ...args], {
    kind: resolved.type,
    path: resolved.type === "wasm" ? resolved.path : null,
  });

  // Make pipe input available to builtins (head etc.) — text form.
  // Binary consumers (wasm programs, gzip, cat) get the raw `stdin`.
  stdinBuffer = pipeText(stdin);
  rawStdin = stdin;

  // While the command runs, route stdout/stderr through suppression
  // guards so an aborted command can't keep spraying output after
  // Ctrl+C. Restore only if we're still the active guard (a nested
  // or newer run may have replaced it).
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  // Transparent suppression wrapper: forwards to its captured target. The
  // `__wraps` link lets nested captures (runNestedCommand) recognise that
  // they're still in the active write chain even while this guard sits on
  // top of them — without it, `bash 'echo x' | grep x` would leak output
  // to the terminal instead of into the pipe.
  // The guard chains to the PREVIOUS writer (which may be a live capture
  // wrap — runNestedCommand's capOut, or the sh2 capture wrap) so a
  // nested command's output still lands in an enclosing $(...) capture;
  // when nothing is capturing, the previous writer IS the real stdout.
  const guardedOut = (chunk) => (suppressOutput ? true : realOut(chunk));
  guardedOut.__wraps = realOut.__wraps || realOut;
  const guardedErr = (chunk) => (suppressOutput ? true : realErr(chunk));
  guardedErr.__wraps = realErr.__wraps || realErr;
  process.stdout.write = guardedOut;
  process.stderr.write = guardedErr;

  try {
    if (resolved.type === "sh") {
      // .sh script or a #!-shebang file. bash/sh → run through the bash
      // transpiler (the shell's native format for bash scripts); any
      // other interpreter is re-dispatched as `<interp> <script> <args>`
      // through the normal command machinery (python/perl/node/lua/…),
      // which resolves and reports not-found itself.
      let interp = "bash";
      if (resolved.shebang) {
        const words = resolved.shebang.split(/\s+/);
        interp = words[words.length - 1].split("/").pop();
        if (interp.startsWith("-")) interp = "bash";   // `#!/bin/sh -e` style
      }
      if (interp !== "bash" && interp !== "sh" && interp !== "dash" && interp !== "ash" && interp !== "ksh") {
        const quoted = [interp, quoteWord(resolved.path), ...args.map((a) => quoteWord(a))].join(" ");
        const r = await runSegment(quoted, stdin, isLast, outputRedirect, appendRedirect);
        procfs.finish(pid, r.code);
        return r;
      }
      let content;
      try {
        content = await fs.read(resolved.path);
      } catch (e) {
        process.stderr.write(`${cmd}: ${e.message}\n`);
        procfs.finish(pid, 1);
        return { ok: false, code: 1, output: "" };
      }
      // Capture output for pipes/redirects, like the builtin branch
      // (runBash writes through process.stdout.write).
      const origWrite = process.stdout.write;
      const chunks = [];
      const capture = outputRedirect || !isLast;
      let captureFn = null;
      if (capture) {
        const preCapture = process.stdout.write;
        captureFn = (chunk) => {
          if (process.stdout.write === captureFn) { chunks.push(chunk); return true; }
          return preCapture.call(process.stdout, chunk);
        };
        process.stdout.write = captureFn;
      }
      let code = 1;
      try {
        code = await runShellScript(content, {
          args,
          argv0: cmd,
          runCmd: runNestedCommand,
        });
      } catch (e) {
        process.stderr.write(`${cmd}: ${e.message}\n`);
      } finally {
        if (capture) {
          if (process.stdout.write === captureFn) process.stdout.write = origWrite;
          const captured = joinOut(chunks);
          if (outputRedirect) await writeOut(outputRedirect, captured, appendRedirect);
          else output = captured;
        }
      }
      procfs.finish(pid, code);
      return { ok: code === 0, code, output };
    }
    if (resolved.type === "wasm") {
      // Go js/wasm binaries (compiled with GOOS=js GOARCH=wasm — `go build`,
      // or any program from the Go toolchain) run through the Go runner
      // (wasm_exec.js + VirtualFS fs shim), not the WASI runner.
      if (await goRunner.isGoModule(resolved.path)) {
        const gr = await goRunner.runModule(resolved.path, [cmd, ...args], stdin);
        if (outputRedirect) {
          await writeOut(outputRedirect, gr.stdout, appendRedirect);
        } else if (isLast) {
          if (gr.stdout) process.stdout.write(gr.stdout);
        } else {
          output = gr.stdout;
        }
        if (gr.stderr) process.stderr.write(gr.stderr);
        if (gr.code !== 0) {
          process.stderr.write(`${cmd}: exited with code ${gr.code}\n`);
          procfs.finish(pid, gr.code);
          return { ok: false, code: gr.code, output: "" };
        }
        procfs.finish(pid, 0);
        return { ok: true, code: 0, output };
      }
      // Run a wasm32-wasi binary (full WASI via @wasmer/wasi, filesystem
      // bridged to our VirtualFS via @wasmer/wasmfs)
      let wasmArgs = [cmd, ...args];
      // cc is intercepted before resolveCommand (see runSegment top)
      await wasmRunner.run(resolved.path, wasmArgs, stdin);
      // Raw stdout bytes (binary-safe) — decode only for the terminal;
      // a pipe carries the bytes so gzip | gunzip round-trips intact.
      const wasmOut = wasmRunner.getStdoutBytes();
      const wasmErr = wasmRunner.getStderr();
      if (outputRedirect) {
        await writeOut(outputRedirect, wasmOut.length ? wasmOut : "", appendRedirect);
      } else if (isLast) {
        if (wasmOut.length) process.stdout.write(pipeText(wasmOut));
      } else {
        output = wasmOut;
      }
      if (wasmErr) {
        process.stderr.write(wasmErr);
      }
      const exitCode = wasmRunner.getExitCode();
      if (exitCode !== 0) {
        process.stderr.write(`${cmd}: exited with code ${exitCode}\n`);
        procfs.finish(pid, exitCode);
        return { ok: false, code: exitCode, output: "" };
      }
      procfs.finish(pid, 0);
      return { ok: true, code: 0, output };
    }

    if (resolved.type === "builtin") {
      const origWrite = process.stdout.write;
      const chunks = [];
      const capture = outputRedirect || !isLast;
      let captureFn = null;
      if (capture) {
        // Guarded capture: only swallow output while THIS command is the
        // current writer. If a background job has swapped the writer
        // meanwhile, forward to the pre-capture writer instead —
        // concurrent output must never be swallowed into someone
        // else's redirect.
        const preCapture = process.stdout.write;
        captureFn = (chunk) => {
          if (process.stdout.write === captureFn) { chunks.push(chunk); return true; }
          return preCapture.call(process.stdout, chunk);
        };
        process.stdout.write = captureFn;
      }
      let code = 0;
      try {
        code = (await resolved.fn(args)) ?? 0;
      } finally {
        if (capture) {
          if (process.stdout.write === captureFn) process.stdout.write = origWrite;
          const captured = joinOut(chunks);
          if (outputRedirect) await writeOut(outputRedirect, captured, appendRedirect);
          else output = captured;
        }
      }
      procfs.finish(pid, code);
      return { ok: code === 0, code, output };
    }

    // Run a .js command file from the virtual filesystem
    const content = await fs.read(resolved.path);
    // Wrap in async IIFE to support top-level await; stdin is the 4th arg.
    // `sh2` is the bash runtime (saved bash2js output calls sh2.exec & co.),
    // `sh2lib` is the debashl toolchain facade (/bin/sh2js.js etc.).
    // `pipe` (10th arg) gives command files the raw pipe: `pipe.in` is
    // the previous segment's stdout (string or Uint8Array — the 4th
    // `stdin` arg is its text form), and `pipe.out(data)` captures
    // output into the pipe (strings or raw bytes; gzip emits bytes).
    const fn = new Function("args", "fs", "console", "stdin", "env", "process", "sh2", "sh2lib", "shell", "qbe2wasm", "pipe", `
        return (async () => {
          ${content}
        })();
      `);
    const logChunks = [];
    const fakeConsole = { log: (...msgs) => logChunks.push(msgs.join(" ") + "\n") };
    const sh2rt = createSh2Runtime({
      fs, env,
      shellExec: runNestedCommand,
      stdout: process.stdout,
      stderr: process.stderr,
      args: args.slice(1),
      argv0: cmd,
    });
    const shellApi = {
      runLine: (cmdLine) => runNestedCommand(cmdLine),
      jobs: getJobScheduler(),   // at/cron scheduler (src/jobs.js)
      // Register a callback fired on Ctrl+C — lets long-running commands
      // (watch, xeyes, ...) tear themselves down when interrupted.
      onInterrupt: (fn) => { interruptCallbacks.push(fn); },
    };
    const pipe = {
      in: stdin,          // raw pipe input (string or Uint8Array)
      out: (data) => logChunks.push(data),  // capture into the pipe
    };
    // `process` for command files: prefer the persistent runtime's shim
    // (otProc has env; the browser's global process is go.js's env-less
    // shim; node's global has everything).
    const fileProc = (otProc && otProc.env)
      ? otProc
      : (typeof process !== "undefined" && process && process.env ? process : { env: env || {} });
    const ret = await fn(args, fs, fakeConsole, pipeText(stdin), env, fileProc, sh2rt.sh2, sh2libFacade, shellApi, qbe2wasm, pipe);
    // A command file may return a number to set its exit status
    const code = typeof ret === "number" ? ret : 0;
    output = joinOut(logChunks);
    if (outputRedirect) {
      await writeOut(outputRedirect, output);
      output = "";
    } else if (isLast) {
      if (output) process.stdout.write(pipeText(output));
      output = "";
    }
    procfs.finish(pid, code);
    return { ok: code === 0, code, output };
  } catch (e) {
    if (e instanceof InterruptError) throw e;
    // A leftover /bin file shadowing a SOURCED function (bash: functions
    // beat files). If the file failed but the name is a sourced function,
    // dispatch through the persistent runtime instead.
    if (otRt && otRt.sh2 && otRt.sh2.functions && otRt.sh2.functions.has(cmd)) {
      try {
        const v = await otRt.sh2.fnCall(cmd, args);
        syncOtVarsFromStore(otRt, otVars);
        procfs.finish(pid, 0);
        return { ok: true, code: 0, output: "" };
      } catch {}
    }
    process.stderr.write(`${cmd}: error: ${e.message} (${resolved.path})\n${e.stack}\n`);
    procfs.finish(pid, 1);
    return { ok: false, code: 1, output: "" };
  } finally {
    // Restore the real writers only if no newer run replaced them.
    if (process.stdout.write === guardedOut) process.stdout.write = realOut;
    if (process.stderr.write === guardedErr) process.stderr.write = realErr;
  }
}

// Split a line into conditional segments on `&&` and `||`, respecting
// quotes and backslash escapes (a `\&&` outside quotes is a literal
// ampersand, not an operator). Returns { text, op } parts where `op`
// is the operator preceding the part ('&&' or '||'), or null for the
// first part. A lone `&` is handled by splitBgList before this runs.
function splitConditionals(line) {
  const parts = [];
  let cur = "";
  let op = null;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      if (i + 1 < line.length) { cur += line[i + 1]; i++; }
      continue;
    }
    if (ch === "'") { inSingle = true; cur += ch; continue; }
    if (ch === '"') { inDouble = true; cur += ch; continue; }
    if ((ch === "&" || ch === "|") && line[i + 1] === ch) {
      parts.push({ text: cur, op });
      cur = "";
      op = ch + ch;
      i++;
      continue;
    }
    if (ch === "&") {
      throw new Error("syntax error near unexpected token '&'");
    }
    cur += ch;
  }
  parts.push({ text: cur, op });
  return parts;
}

// Run one pipeline (`|`-separated commands), feeding each command's
// stdout to the next command's stdin. Returns the pipeline's exit
// status: the first failing command's status, else the last one's.
// python — run through the MicroPython reactor (src/py.js). The engine
// is a singleton, so state persists across lines and invocations.
async function runPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect) {
  if (args.length === 0) {
    if (pipeText(stdin).trim()) {
      args = ["-"];
    } else if (process.stdin.isTTY) {
      enterPythonRepl();
      return { ok: true, code: 0, output: "" };
    } else {
      process.stderr.write("python: no script given (python -c CODE | script.py | - for stdin)\n");
      return { ok: false, code: 2, output: "" };
    }
  }
  let source = null;
  if (args[0] === "-c" || args[0] === "-e") {
    source = args.slice(1).join(" ");
  } else if (args[0] === "-") {
    source = pipeText(stdin);
  } else if (!args[0].startsWith("-")) {
    try {
      source = await fs.read(args[0]);
    } catch (e) {
      process.stderr.write(`python: ${args[0]}: ${e.message}\n`);
      return { ok: false, code: 1, output: "" };
    }
  } else {
    process.stderr.write(`python: unknown option ${args[0]}\n`);
    return { ok: false, code: 2, output: "" };
  }
  if (source === null) {
    process.stderr.write("python: no script given (python -c CODE | script.py | - for stdin)\n");
    return { ok: false, code: 2, output: "" };
  }
  const { pyExec } = await import("./py.js");
  let output = "";
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { output += s; return true; };
  let code;
  try {
    code = await pyExec(source, { stdout: process.stdout, stderr: process.stderr });
  } catch (e) {
    process.stderr.write(`python: ${e.message}\n`);
    code = 1;
  } finally {
    process.stdout.write = origWrite;
  }
  if (outputRedirect) {
    await writeOut(outputRedirect, output, appendRedirect);
    output = "";
  } else if (isLast) {
    process.stdout.write(output);
    output = "";
  }
  return { ok: code === 0, code, output };
}

async function runPipeline(pipelineText, initialStdin = "") {
  const segments = splitPipe(pipelineText);
  let stdin = initialStdin;
  let exitCode = 0;
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].trim()) {
      process.stderr.write(`jtsh: syntax error near unexpected token '|'\n`);
      return 2;
    }
    const result = await runSegment(segments[i], stdin, i === segments.length - 1);
    if (!result.ok) return result.code ?? 1;
    stdin = result.output;
    exitCode = result.code ?? 0;
  }
  return exitCode;
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
function splitBgList(line) {
  const parts = [];
  let cur = "";
  let bg = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      if (i + 1 < line.length) { cur += line[i + 1]; i++; }
      continue;
    }
    if (ch === "'") { inSingle = true; cur += ch; continue; }
    if (ch === '"') { inDouble = true; cur += ch; continue; }
    if (ch === "&") {
      if (line[i + 1] === "&") { cur += "&&"; i++; continue; }  // conditional op
      parts.push({ text: cur, bg: true });
      cur = "";
      continue;
    }
    cur += ch;
  }
  // A line ending in `&` leaves cur empty after the split — don't push
  // a phantom trailing segment (`cmd &` has no command after the &).
  if (cur !== "" || parts.length === 0) parts.push({ text: cur, bg });
  return parts;
}

async function handleLine(line, initialStdin) {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Split on `&` first — each `&`-terminated segment runs as a
  // background job, everything else runs in the foreground. Segments
  // themselves are conditional lists (`&&` / `||`) of pipelines.
  let segments;
  try {
    segments = splitBgList(trimmed);
  } catch (e) {
    process.stderr.write(`jtsh: ${e.message}\n`);
    return;
  }
  for (const seg of segments) {
    if (!seg.text.trim()) {
      process.stderr.write(`jtsh: syntax error near unexpected token '&'\n`);
      return;
    }
    // Validate a background segment's conditional structure now, so a
    // broken `sleep 1 && &` fails at the prompt instead of launching a
    // job that dies silently.
    if (seg.bg) {
      let cond;
      try {
        cond = splitConditionals(seg.text);
      } catch (e) {
        process.stderr.write(`jtsh: ${e.message}\n`);
        return;
      }
      const bad = cond.find((p) => !p.text.trim());
      if (bad) {
        const token = bad.op || "newline";
        process.stderr.write(`jtsh: syntax error near unexpected token '${token}'\n`);
        return;
      }
    }
  }

  let exitCode = 0;
  for (const seg of segments) {
    if (seg.bg) {
      const job = getBgJobs().launch(seg.text);
      setLastBgPid(job.pid);   // $! — last background job's pid
      process.stdout.write(`[${job.id}] ${job.pid}\n`);
    } else {
      exitCode = await runConditionalList(seg.text, initialStdin);
    }
  }
  return exitCode;
}

// Run one conditional list (`&&` / `||`-joined pipelines) — the
// foreground part of a line, or the body of a background job.
async function runConditionalList(text, initialStdin) {
  let parts;
  try {
    parts = splitConditionals(text);
  } catch (e) {
    process.stderr.write(`jtsh: ${e.message}\n`);
    return 2;
  }
  // An empty segment means the segment started with an operator, ended
  // with one, or had two operators in a row (`&& echo hi`, `echo hi &&`,
  // `a && || b`) — all syntax errors.
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].text.trim()) {
      const nextOp = i + 1 < parts.length ? parts[i + 1].op : null;
      const token = nextOp ? `'${nextOp}'` : "newline";
      process.stderr.write(`jtsh: syntax error near unexpected token ${token}\n`);
      return 2;
    }
  }

  let exitCode = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      if (parts[i].op === "&&" && exitCode !== 0) continue;
      if (parts[i].op === "||" && exitCode === 0) continue;
    }
    // Bash-only syntax (statement separators, for/if keywords, $(…)…)
    // routes through the otranspilerl fallback BEFORE the tokenizer —
    // jtsh's own parser doesn't understand it natively.
    if (hasOption("x")) process.stderr.write(`+ ${parts[i].text}\n`);   // set -x
    if (looksLikeBash(parts[i].text)) {
      try {
        exitCode = await runViaTranspiler(parts[i].text, initialStdin);
      } catch (e) {
        // The library refused (outside its subset) or the shape needs the
        // sync bridge — fall back to the normal pipeline, which reports
        // the not-found / literal exactly as before.
        exitCode = await runPipeline(parts[i].text, initialStdin);
      }
      setShellStatus(exitCode);   // $? reflects every command, native or transpiled
      continue;
    }
    exitCode = await runPipeline(parts[i].text, initialStdin);
    setShellStatus(exitCode);
  }
  return exitCode;
}

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
  if (replState.mode === "python") {
    const t = line.trim();
    if (t === "exit()" || t === "quit()") { exitRepl(); return; }
    try {
      const { pyExec } = await import("./py.js");
      await pyExec(line, { stdout: process.stdout, stderr: process.stderr });
    } catch (e) {
      process.stderr.write(`python: ${e.message}\n`);
    }
  } else if (replState.mode === "bash") {
    const t = line.trim();
    if (!t) return;
    // exit / quit / "exit 5" leave the REPL (never reach the shell's exit)
    if (t === "exit" || t === "quit" || t === ":q" ||
        t.indexOf("exit ") === 0 || t.indexOf("quit ") === 0) { exitRepl(); return; }
    try {
      // Session replay: re-transpile and re-run every line so far plus
      // the new one, bracketed by two echo markers (PRE before the new
      // line, POST after). debashcl silently DROPS invalid statements
      // (and everything after them), so if POST is missing the line was
      // never run — we report it and leave the session untouched.
      // Variables and functions persist because the whole session
      // re-declares them; only the output between the markers is shown.
      // runBash rewrites the marker echos to direct stdout writes, so
      // the PRE marker can't clobber $? for the new line (`false` then
      // `echo $?` must print 1, like bash).
      replState.bashOut = "";
      const session = replState.bashSession;
      const pre = replState.bashMarker;
      const post = replState.bashMarker + "_end";
      const src = (session.length > 0 ? session.join("\n") + "\n" : "") +
        "echo '" + pre + "'\n" + line + "\necho '" + post + "'\n";
      const { runBash } = await import("./bash2js.js");
      await runBash(fs, src, {
        runCmd: runNestedCommand,
        stdout: { write: (s) => { replState.bashOut += s; } },
        stderr: { write: (s) => { replState.bashOut += s; } },
        markers: [pre, post],
      });
      const pi = replState.bashOut.indexOf(pre);
      const pj = replState.bashOut.lastIndexOf(post);
      if (pi === -1 || pj === -1 || pj < pi) {
        // POST never printed — the statement was dropped/truncated
        process.stderr.write("bash: syntax error — the line was not run (session unchanged)\n");

      } else {
        // The PRE marker's echo appends its own newline, so the slice
        // after it starts with "\n" — strip it, or every command's
        // output would be preceded by a blank line (and no-output lines
        // like `x=5` would print one).
        const fresh = replState.bashOut.slice(pi + pre.length, pj).replace(/^\n+/, "");
        if (fresh) process.stdout.write(fresh);
        session.push(line);
      }
    } catch (e) {
      process.stderr.write(`bash: ${(e && e.message) ? e.message : String(e)}\n`);
    }
  } else if (replState.mode === "cmd") {
    const t = line.trim();
    if (!t) return;
    // exit / exit /b N / quit leave the REPL (never reach the shell's exit)
    if (/^(exit|quit)\b/.test(t) || t === ":q") { exitRepl(); return; }
    try {
      // Session replay: re-transpile and re-run every line so far plus
      // the new one, bracketed by two echo markers (PRE before the new
      // line, POST after). The bat frontend REFUSES loud (unlike bash's
      // silent drop), so if POST is missing the line never ran — we
      // report it and leave the session untouched. Variables persist
      // because the whole session re-declares them; only the output
      // between the markers is shown. Batch `echo` compiles to a direct
      // stdout write (no exec), so the PRE marker can't clobber
      // %errorlevel% for the new line (`exit /b 5` then `echo
      // %errorlevel%` must print 5, like cmd).
      replState.cmdOut = "";
      const session = replState.cmdSession;
      const pre = replState.cmdMarker;
      const post = replState.cmdMarker + "_end";
      const src = (session.length > 0 ? session.join("\n") + "\n" : "") +
        "echo " + pre + "\n" + line + "\necho " + post + "\n";
      const { runBat } = await import("./bat2js.js");
      await runBat(fs, src, {
        runCmd: runNestedCommand,
        stdout: { write: (s) => { replState.cmdOut += s; } },
        stderr: { write: (s) => { replState.cmdOut += s; } },
      });
      const pi = replState.cmdOut.indexOf(pre);
      const pj = replState.cmdOut.lastIndexOf(post);
      if (pi === -1 || pj === -1 || pj < pi) {
        // POST never printed — the statement was refused/truncated
        process.stderr.write("cmd.exe: syntax error — the line was not run (session unchanged)\n");
      } else {
        // The PRE marker's echo appends its own newline, so the slice
        // after it starts with "\n" — strip it, or every command's
        // output would be preceded by a blank line (and no-output lines
        // like `set X=5` would print one).
        const fresh = replState.cmdOut.slice(pi + pre.length, pj).replace(/^\n+/, "");
        if (fresh) process.stdout.write(fresh);
        session.push(line);
      }
    } catch (e) {
      process.stderr.write(`cmd.exe: ${(e && e.message) ? e.message : String(e)}\n`);
    }
  } else {
    const t = line.trim();
    if (t === "exit" || t === "quit" || t === ":q") { exitRepl(); return; }
    try {
      await replState.perlReady;
      if (!replState.active) return;
      // Session replay: re-run every line so far plus the new one, with
      // a marker printed between the old code and the new line. `my`
      // lexicals from earlier lines survive because they're re-declared
      // in the same eval; only the output after the marker is shown.
      replState.perlOut = "";
      const session = replState.perlSession;
      // Separate statements with ";" — a bare newline doesn't end a Perl
      // statement (my $x=9 works as the last line of an eval but breaks
      // when more code follows), and only successful lines join the
      // session so an error never poisons the replay.
      const code = (session.length > 0 ? session.join(";\n") + ";\n" : "") +
        "print " + JSON.stringify(replState.perlMarker + "\n") + ";\n" +
        line;
      const res = await replState.perl.eval(code, []);
      try { replState.perl.flush(); } catch (e) {}
      const marker = replState.perlMarker;
      const splitAt = replState.perlOut.lastIndexOf(marker + "\n");
      if (splitAt !== -1) {
        const fresh = replState.perlOut.slice(splitAt + marker.length + 1);
        if (fresh) process.stdout.write(fresh);
      }
      if (res && res.success && line.trim()) session.push(line);
      if (res && !res.success && res.error) process.stderr.write(String(res.error));
    } catch (e) {
      process.stderr.write(`perl: ${e.message}\n`);
    }
  }
  if (replState.active) {
    rl.setPrompt(replState.mode === "perl" ? "perl> " : replState.mode === "bash" ? "bash> " : replState.mode === "cmd" ? "cmd> " : ">>> ");
    rl.prompt();
  }
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
