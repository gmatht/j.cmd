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
  async ls(args) {
    // Parse flags: -l (long format with permissions/size/date)
    let long = false;
    const dirs = [];
    for (const a of args) {
      if (a === "-l" || a === "--long" || a === "-la" || a === "-al") {
        long = true;
      } else if (a.startsWith("-")) {
        process.stderr.write(`ls: invalid option -- '${a}'\n`);
        return 2;
      } else {
        dirs.push(a);
      }
    }
    if (dirs.length === 0) dirs.push(".");
    let hadError = false;
    for (const dir of dirs) {
      try {
        // `ls <file>` prints the file's own entry (like real ls); a
        // directory lists its contents.
        const st = await fs.stat(dir);
        if (st && st.type === "file") {
          const output = long
            ? await fs.formatLongFile(dir)
            : (dir.split("/").filter(Boolean).pop() || "/") + "\n";
          process.stdout.write(output);
          continue;
        }
        const output = await fs.formatList(dir, { long });
        if (!output) continue;
        if (dirs.length > 1) process.stdout.write(`${dir}:\n`);
        process.stdout.write(output);
        // Note when a remote listing came from the persistent ls cache
        // (24h TTL) — "cached 3h ago" beats a silent, unexplained list.
        // A fresh fetch also writes the cache (age ≈ 0) and a cd into a
        // remote dir fetches + caches too, so "cached" is decided by
        // whether THIS listing hit the API (rate info) or not (cache
        // age) rather than by a fixed age cut-off.
        const cacheNote = await fs.cacheInfo(dir);
        const rate = await fs.rateInfo(dir);
        if (cacheNote && cacheNote.stale) {
          // Last-resort fallback (API down / rate-limited)
          process.stdout.write(`  (cached ${formatAge(cacheNote.age)} — API unavailable, stale)\n`);
        } else if (rate && rate.limit > 0) {
          // Fresh request — report the API's rolling-hour usage from the
          // response headers (exact for the IP, not an estimate).
          const used = Math.max(0, rate.limit - rate.remaining);
          process.stdout.write(`  (${rate.name}: ${used}/${rate.limit} API requests used ${rate.period})\n`);
        } else if (cacheNote) {
          // Served from cache — a just-completed cd fetched and cached
          // this dir, so an ls right after hits the cache (age < 1min).
          process.stdout.write(`  (cached ${formatAge(cacheNote.age)})\n`);
        }
      } catch (e) {
        hadError = true;
        process.stderr.write(`ls: ${dir}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  async cat(args) {
    if (args.length === 0) {
      // No files — read from stdin (pipe input). Write the raw pipe
      // data so binary streams (gzip/zstd output) pass through bytes.
      const data = rawStdin;
      if (data === "") return 0;
      const endsNL = typeof data === "string"
        ? data.endsWith("\n")
        : data[data.length - 1] === 10;
      process.stdout.write(data);
      if (!endsNL) process.stdout.write("\n");
      return 0;
    }
    let hadError = false;
    for (const file of args) {
      try {
        // Binary safe: read the raw bytes. Valid UTF-8 is written as
        // text (terminal rendering, grep pipelines); anything else
        // passes through raw bytes, so `cat file.gz | gunzip` works.
        const blob = await fs.readBlob(file);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text = null;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
        if (text !== null) {
          process.stdout.write(text);
          if (!text.endsWith("\n")) process.stdout.write("\n");
        } else {
          process.stdout.write(bytes);
        }
      } catch (e) {
        hadError = true;
        process.stderr.write(`cat: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  async echo(args) {
    process.stdout.write(args.join(" ") + "\n");
    return 0;
  },

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

  async pwd(args) {
    process.stdout.write((fs.view ? fs.view(fs.cwd) : fs.cwd) + "\n");
    return 0;
  },

  async true(args) {
    // Always succeeds (exit 0) — handy with `&&`
    return 0;
  },

  async clear(args) {
    // ANSI clear-screen (keeps the readline scrollback, like real clear)
    process.stdout.write("\x1b[2J\x1b[H");
    return 0;
  },

  async cls(args) {
    // cls — Windows-style alias for clear
    process.stdout.write("\x1b[2J\x1b[H");
    return 0;
  },

  async bug(args) {
    // bug — file a bug report as a GitHub issue (gmatht/j.cmd, label
    // bug-report) carrying the last terminal lines (the ring buffer)
    // plus an expected-behaviour note. CLI form is non-interactive:
    //   bug "can't compile hello"            → report from the ring buffer
    //   bug --expect "should print 42" "msg"  → what the user expected
    //   bug --lines 50 "msg"                 → more terminal context
    //   bug --dry-run "msg"                  → print the report, post nothing
    //   bug --webform "msg"                  → print the prefilled GitHub form URL
    //   bug --token <PAT>                    → save a token (~/.jtsh-gh-token)
    //   bug --clear-token                    → forget it
    // Token: $JTSH_GITHUB_TOKEN or ~/.jtsh-gh-token. Without one, the
    // report is written to ./jtsh-bug-report.md and the prefilled
    // GitHub form URL is printed. Triage: ./bug-triage.sh
    const { buildReport, postIssue, getBugToken, setBugToken, clearBugToken, BUG_REPO } = await import("./bugreport.js");
    let expect = "", lines = 20, dryRun = false, webform = false, rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--expect" && args[i + 1]) expect = args[++i];
      else if (a === "--lines" && args[i + 1]) lines = Math.max(1, parseInt(args[++i], 10) || 20);
      else if (a === "--dry-run") dryRun = true;
      else if (a === "--webform") webform = true;
      else if (a === "--token" && args[i + 1]) { await setBugToken(null, args[++i]); process.stdout.write("bug: token saved to ~/.jtsh-gh-token\n"); return 0; }
      else if (a === "--clear-token") { clearBugToken(null); try { const { rmSync } = await import("node:fs"); rmSync(`${process.env.HOME || process.cwd()}/.jtsh-gh-token`, { force: true }); } catch {} process.stdout.write("bug: token cleared\n"); return 0; }
      else if (!a.startsWith("-")) rest.push(a);
    }
    const summary = rest.join(" ");
    const snippet = outRing.slice(-lines).join("\n").replace(/^\s+|\s+$/g, "");
    const scope = lines === 20 ? "20" : String(lines);
    const body = buildReport({ summary, expected: expect, snippet, scope, system: await collectSystem(), commit: await collectCommit() });
    if (dryRun) { process.stdout.write(body); return 0; }
    const title = "bug: " + ((summary || "").trim().slice(0, 100) || "terminal snippet report");
    const token = webform ? null : await getBugToken(null);
    if (!token) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("jtsh-bug-report.md", body);
      process.stdout.write("bug: no GitHub token — report saved to ./jtsh-bug-report.md.\n");
      process.stdout.write(`     Set one with: bug --token <PAT>  (or $JTSH_GITHUB_TOKEN)\n`);
      const url = `https://github.com/${BUG_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      process.stdout.write(`     …or open the prefilled GitHub form:\n     ${url}\n`);
      return 0;
    }
    try {
      const url = await postIssue({ token, title, body });
      process.stdout.write(`bug: filed → ${url}\n`);
    } catch (e) {
      process.stderr.write(`bug: ${e.message}\n`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync("jtsh-bug-report.md", body);
      process.stdout.write("bug: report saved to ./jtsh-bug-report.md — paste it into an issue manually.\n");
    }
    return 0;
  },

  async false(args) {
    // Always fails (exit 1) — handy with `||`
    return 1;
  },

  async cd(args) {
    let dir = args[0] || env.HOME;
    if (dir === "-") {
      // cd - → the previous directory (and print it, like bash)
      if (!env.OLDPWD) {
        process.stderr.write("cd: OLDPWD not set\n");
        return 1;
      }
      dir = env.OLDPWD;
    }
    try {
      await fs.list(dir);
      const r = fs._resolve(dir);
      env.OLDPWD = env.PWD;   // bash keeps OLDPWD for `cd -` / $OLDPWD
      fs.cwd = r;
      env.PWD = r;
      if (args[0] === "-") process.stdout.write(r + "\n");
      // cd into a remote mount may have just fetched (and cached) the
      // listing — surface the API usage from that fetch, like ls does.
      // (ls right after will show "cached just now" instead.)
      const rate = await fs.rateInfo(dir);
      if (rate && rate.limit > 0) {
        const used = Math.max(0, rate.limit - rate.remaining);
        process.stdout.write(`  (${rate.name}: ${used}/${rate.limit} API requests used ${rate.period})\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`cd: ${dir}: ${e.message}\n`);
      return 1;
    }
  },

  async export(args) {
    // export [NAME[=VALUE]...] — set environment variables.
    // `export` or `export -p` prints all variables in POSIX form.
    // `export NAME=value` sets NAME to value (split on the first '=');
    // `export NAME` sets NAME to an empty string, like bash.
    // Invalid identifiers are reported and skipped; exit status is 1
    // if any argument was invalid.
    if (args.length === 0 || (args.length === 1 && args[0] === "-p")) {
      for (const key of Object.keys(env).sort()) {
        process.stdout.write(`export ${key}=${env[key]}\n`);
      }
      return 0;
    }
    let hadError = false;
    for (const arg of args) {
      if (arg === "-p" || arg === "-n") continue; // -n: jtsh has no un-exported vars (env is the store), so it's a no-op
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        hadError = true;
        process.stderr.write(`export: '${arg}': not a valid identifier\n`);
        continue;
      }
      if (isReadonly(name)) {
        hadError = true;
        process.stderr.write(`export: ${name}: readonly variable\n`);
        continue;
      }
      env[name] = eq === -1 ? "" : arg.slice(eq + 1);
    }
    return hadError ? 1 : 0;
  },

  async set(args) {
    // set                     — print shell variables
    // set -- a b c            — set the positional parameters ($1 $2 $3)
    // set a b c               — same (first non-option arg starts $1)
    // set -eux / set +eux     — option flags (accepted and stored; -x is
    //                           honoured natively, -e/-u are no-ops in an
    //                           interactive shell by POSIX design)
    // set -o errexit|nounset|xtrace — long forms
    if (args.length === 0) {
      for (const key of Object.keys(env).sort()) {
        process.stdout.write(`${key}=${env[key]}\n`);
      }
      return 0;
    }
    const OPTION_NAMES = { errexit: "e", nounset: "u", xtrace: "x", noglob: "f", allexport: "a" };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { setPositional(args.slice(i + 1)); return 0; }
      if (a === "-o" || a === "+o") {
        const name = args[i + 1];
        if (!name) { process.stderr.write(`set: ${a}: needs an option name\n`); return 2; }
        const f = OPTION_NAMES[name];
        if (!f) { process.stderr.write(`set: -o: ${name}: invalid option name\n`); return 2; }
        setOption(f, a === "-o");
        i++;
        continue;
      }
      if (a.startsWith("-") || a.startsWith("+")) {
        const on = a[0] === "-";
        for (const ch of a.slice(1)) setOption(ch, on);
        continue;
      }
      // first non-option argument → the positional parameters
      setPositional(args.slice(i));
      return 0;
    }
    return 0;
  },

  async readonly(args) {
    // readonly [NAME[=VALUE]...] — mark variables read-only.
    // `readonly` / `readonly -p` — list them. Reassignment (export /
    // transpiled setVar) refuses with "readonly variable" and $? = 1.
    if (args.length === 0 || (args.length === 1 && args[0] === "-p")) {
      for (const name of listReadonly().sort()) {
        const v = env[name] !== undefined ? env[name] : "";
        process.stdout.write(`readonly ${name}=${v}\n`);
      }
      return 0;
    }
    let hadError = false;
    for (const arg of args) {
      if (arg === "-p") continue;
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        hadError = true;
        process.stderr.write(`readonly: '${arg}': not a valid identifier\n`);
        continue;
      }
      if (eq !== -1) {
        if (isReadonly(name) && env[name] !== undefined) {
          hadError = true;
          process.stderr.write(`readonly: ${name}: readonly variable\n`);
          continue;
        }
        env[name] = arg.slice(eq + 1);
      }
      markReadonly(name);
    }
    return hadError ? 1 : 0;
  },

  async unset(args) {
    // unset [NAME...] — remove variables from the environment AND the
    // transpiled persistent state (env / otVars / otRt.sh2.vars stay in
    // sync, so native and transpiled code agree). Flags (-v/-f) are
    // accepted and ignored; `unset` with no args is a no-op, like bash.
    let hadError = false;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
        hadError = true;
        process.stderr.write(`unset: '${arg}': not a valid identifier\n`);
        continue;
      }
      delete env[arg];
      otVars.delete(arg);
      try { delete otRt.sh2.vars[arg]; } catch {}
    }
    return hadError ? 1 : 0;
  },

  async rm(args) {
    if (args.length === 0) {
      process.stderr.write("rm: missing operand\n");
      return 2;
    }
    let hadError = false;
    for (const file of args) {
      try {
        // stat follows symlinks, so a dangling link (target missing)
        // looks nonexistent — but rm should still unlink the link
        // itself, like real rm. readlink confirms it's a link.
        const st = await fs.stat(file).catch(() => null);
        if (!st && !(await fs.readlink(file).catch(() => null))) {
          throw new Error("ENOENT: no such file");
        }
        await fs.remove(file);
      } catch (e) {
        hadError = true;
        process.stderr.write(`rm: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  async mkdir(args) {
    if (args.length === 0) {
      process.stderr.write("mkdir: missing operand\n");
      return 2;
    }
    let hadError = false;
    for (const dir of args) {
      try {
        const r = fs._resolve(dir);
        await fs.write(r + "/.directory", "");
      } catch (e) {
        hadError = true;
        process.stderr.write(`mkdir: ${dir}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  async cp(args) {
    if (args.length < 2) {
      process.stderr.write("cp: missing operand\n");
      return 2;
    }
    const src = args[0];
    let dest = args[1];
    // If dest is a directory (trailing /), a bare mount point like /pc,
    // or the current dir '.' — append the source basename (same as the
    // browser shell's cp).
    const base = src.split("/").pop();
    if (dest.endsWith("/") || dest === "/pc" || dest === "." || dest === "..") {
      dest = dest.endsWith("/") ? dest + base : dest + "/" + base;
    }
    try {
      // Binary-aware copy (readBlob/writeBlob); falls back to text for
      // backends without blob support.
      try {
        const blob = await fs.readBlob(src);
        await fs.writeBlob(dest, blob);
      } catch {
        const content = await fs.read(src);
        await fs.write(dest, content);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`cp: ${src}: ${e.message}\n`);
      return 1;
    }
  },

  async mv(args) {
    if (args.length < 2) {
      process.stderr.write("mv: missing operand\n");
      return 2;
    }
    const src = args[0];
    let dest = args[1];
    const base = src.split("/").pop();
    if (dest.endsWith("/") || dest === "/pc" || dest === "." || dest === "..") {
      dest = dest.endsWith("/") ? dest + base : dest + "/" + base;
    }
    try {
      // Moving a symlink relinks it — the target is never copied or
      // moved (mv follows the link's path, not its destination).
      const target = await fs.readlink(src).catch(() => null);
      if (target !== null) {
        await fs.link(target, dest);
        await fs.remove(src);
        return 0;
      }
      // Binary-aware move, like cp (zips and other binary files must
      // round-trip their bytes).
      try {
        const blob = await fs.readBlob(src);
        await fs.writeBlob(dest, blob);
      } catch {
        const content = await fs.read(src);
        await fs.write(dest, content);
      }
      await fs.remove(src);
      return 0;
    } catch (e) {
      process.stderr.write(`mv: ${src}: ${e.message}\n`);
      return 1;
    }
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

  async head(args) {
    // head [-n N] [file...] — print the first N lines (default 10).
    // With no file arguments, reads from stdin (i.e. a pipe).
    let count = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" || a === "--lines") {
        count = parseInt(args[i + 1], 10);
        if (isNaN(count)) {
          process.stderr.write(`head: invalid number of lines: '${args[i + 1]}'\n`);
          return 2;
        }
        i++;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10);
      } else if (/^\d+$/.test(a)) {
        count = parseInt(a, 10);   // friendly: `tail 1` == `tail -n 1`
      } else if (a.startsWith("-")) {
        process.stderr.write(`head: invalid option -- '${a}'\n`);
        return 2;
      } else {
        files.push(a);
      }
    }
    if (count < 0) count = 0;

    const printLines = (content) => {
      if (content === "") return;
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop(); // drop trailing newline
      if (lines.length === 0) return;
      process.stdout.write(lines.slice(0, count).join("\n") + "\n");
    };

    if (files.length === 0) {
      printLines(stdinBuffer);
      return 0;
    }
    let hadError = false;
    for (const file of files) {
      try {
        const content = await fs.read(file);
        if (files.length > 1) process.stdout.write(`==> ${file} <==\n`);
        printLines(content);
      } catch (e) {
        hadError = true;
        process.stderr.write(`head: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  async tail(args) {
    // tail [-n N] [file...] — print the last N lines (default 10).
    // With no file arguments, reads from stdin (i.e. a pipe).
    let count = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" || a === "--lines") {
        count = parseInt(args[i + 1], 10);
        if (isNaN(count)) {
          process.stderr.write(`tail: invalid number of lines: '${args[i + 1]}'\n`);
          return 2;
        }
        i++;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10);
      } else if (/^\d+$/.test(a)) {
        count = parseInt(a, 10);   // friendly: `tail 1` == `tail -n 1`
      } else if (a.startsWith("-")) {
        process.stderr.write(`tail: invalid option -- '${a}'\n`);
        return 2;
      } else {
        files.push(a);
      }
    }
    if (count < 0) count = 0;

    const printLines = (content) => {
      if (content === "") return;
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop(); // drop trailing newline
      if (lines.length === 0) return;
      const out = count === 0 ? [] : lines.slice(-count);
      if (out.length === 0) return;
      process.stdout.write(out.join("\n") + "\n");
    };

    if (files.length === 0) {
      printLines(stdinBuffer);
      return 0;
    }
    let hadError = false;
    for (const file of files) {
      try {
        const content = await fs.read(file);
        if (files.length > 1) process.stdout.write(`==> ${file} <==\n`);
        printLines(content);
      } catch (e) {
        hadError = true;
        process.stderr.write(`tail: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  },

  async sleep(args) {
    // sleep [N] — delay for N seconds (floats ok; default 1). Needed by
    // game loops (mimecroft) and scripts.
    let secs = 1;
    if (args.length > 0) {
      secs = parseFloat(args[0]);
      if (isNaN(secs) || secs < 0) {
        process.stderr.write(`sleep: invalid time interval '${args[0]}'\n`);
        return 2;
      }
    }
    await new Promise((r) => setTimeout(r, Math.round(secs * 1000)));
    return 0;
  },

  async grep(args) {
    // grep [-i] [-n] [-v] [-c] [-l] [-r] [-o] [-e PATTERN] [--] PATTERN [FILE...]
    // With no FILE arguments, searches stdin (pipe input).
    let ignoreCase = false, lineNumber = false, invert = false;
    let count = false, filesWithMatches = false, recursive = false;
    let onlyMatching = false;
    let pattern = null, patternExplicit = false;
    const patterns = [];
    const files = [];
    let optsDone = false;

    const shortFlags = {
      i: () => ignoreCase = true,
      n: () => lineNumber = true,
      v: () => invert = true,
      c: () => count = true,
      l: () => filesWithMatches = true,
      r: () => recursive = true,
      R: () => recursive = true,
      o: () => onlyMatching = true,
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--" && !optsDone) { optsDone = true; continue; }
      if (!optsDone && (a === "-i" || a === "--ignore-case")) ignoreCase = true;
      else if (!optsDone && (a === "-n" || a === "--line-number")) lineNumber = true;
      else if (!optsDone && (a === "-v" || a === "--invert-match")) invert = true;
      else if (!optsDone && (a === "-c" || a === "--count")) count = true;
      else if (!optsDone && (a === "-l" || a === "--files-with-matches")) filesWithMatches = true;
      else if (!optsDone && (a === "-r" || a === "-R" || a === "--recursive")) recursive = true;
      else if (!optsDone && (a === "-o" || a === "--only-matching")) onlyMatching = true;
      else if (!optsDone && (a === "-e" || a === "--regexp")) {
        if (i + 1 >= args.length) {
          process.stderr.write(`grep: option requires an argument -- '${a}'\n`);
          return 2;
        }
        pattern = args[++i];
        patterns.push(pattern);
        patternExplicit = true;
      } else if (!optsDone && a.startsWith("--")) {
        process.stderr.write(`grep: unrecognized option '${a}'\n`);
        return 2;
      } else if (!optsDone && a.startsWith("-") && a.length > 1) {
        // Bundled short flags, e.g. -in or -cv
        let ok = true;
        for (const ch of a.slice(1)) {
          if (shortFlags[ch]) shortFlags[ch]();
          else { ok = false; break; }
        }
        if (!ok) {
          process.stderr.write(`grep: invalid option -- '${a}'\n`);
          return 2;
        }
      } else if (!patternExplicit && pattern === null) {
        pattern = a;
        patterns.push(a);
      } else {
        files.push(a);
      }
    }

    if (patterns.length === 0) {
      process.stderr.write("grep: missing pattern\n");
      return 2;
    }
    // Multiple -e patterns match if ANY of them matches (OR)
    const patternSource = patterns.map(p => `(?:${p})`).join("|");

    let re;
    try {
      re = new RegExp(patternSource, ignoreCase ? "i" : "");
    } catch (e) {
      process.stderr.write(`grep: invalid regular expression: '${patterns.join("', '")}'\n`);
      return 2;
    }

    // Remote mounts would require crawling the network; refuse that and
    // only grep them when a specific file is named.
    const REMOTE = ["/http/", "/github/", "/mount/github/", "/gitlab/", "/mount/gitlab/", "/git/", "/mount/git/"];
    const isRemote = (p) => REMOTE.some(pre => p === pre.slice(0, -1) || p.startsWith(pre));

    const showLabel = files.length > 1 || recursive;

    const processContent = (content, label) => {
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop(); // drop trailing newline
      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]) !== invert) hits.push({ num: i + 1, text: lines[i] });
      }
      if (count) {
        process.stdout.write((showLabel ? label + ":" : "") + hits.length + "\n");
      } else if (filesWithMatches) {
        if (hits.length > 0) process.stdout.write(label + "\n");
      } else if (onlyMatching && !invert) {
        // -o: print each match on its own line (GNU: no effect with -v).
        // Skip zero-length matches to avoid a position walk.
        const gm = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        for (const h of hits) {
          let m;
          while ((m = gm.exec(h.text)) !== null) {
            if (m[0].length === 0) { gm.lastIndex++; continue; }
            process.stdout.write(
              (showLabel ? label + ":" : "") +
              (lineNumber ? h.num + ":" : "") +
              m[0] + "\n"
            );
          }
        }
      } else {
        for (const h of hits) {
          process.stdout.write(
            (showLabel ? label + ":" : "") +
            (lineNumber ? h.num + ":" : "") +
            h.text + "\n"
          );
        }
      }
      return hits.length;
    };

    if (files.length === 0) {
      const hits = processContent(stdinBuffer, "(standard input)");
      return hits > 0 ? 0 : 1;
    }

    // grep exit status: 0 if any line matched, 1 if none did, 2 on error
    let hadError = false;
    let anyHits = 0;

    // Recursively collect files under a directory
    const walk = async (dir) => {
      if (isRemote(dir)) {
        hadError = true;
        process.stderr.write(`grep: skipping remote mount ${dir} (name specific files to search them)\n`);
        return;
      }
      let entries;
      try { entries = await fs.list(dir); } catch (e) {
        hadError = true;
        process.stderr.write(`grep: ${dir}: ${e.message}\n`);
        return;
      }
      for (const entry of entries) {
        const clean = entry.replace(/\/$/, "");
        const full = (dir === "/" ? "/" : dir + "/") + clean;
        let st;
        try { st = await fs.stat(full); } catch { continue; }
        if (st.type === "dir") await walk(full);
        else {
          try {
            const content = await fs.read(full);
            anyHits += processContent(content, full);
          } catch (e) {
            hadError = true;
            process.stderr.write(`grep: ${full}: ${e.message}\n`);
          }
        }
      }
    };

    const seen = new Set();
    for (const file of files) {
      const r = fs._resolve(file);
      if (seen.has(r)) continue;
      seen.add(r);
      if (recursive && isRemote(r)) {
        hadError = true;
        process.stderr.write(`grep: skipping remote mount ${r} (name specific files to search them)\n`);
        continue;
      }
      try {
        const st = await fs.stat(file);
        if (st.type === "dir") {
          if (recursive) await walk(r);
          else {
            hadError = true;
            process.stderr.write(`grep: ${file}: Is a directory\n`);
          }
          continue;
        }
        const content = await fs.read(file);
        anyHits += processContent(content, r);
      } catch (e) {
        hadError = true;
        process.stderr.write(`grep: ${file}: ${e.message}\n`);
      }
    }
    if (hadError) return 2;
    return anyHits > 0 ? 0 : 1;
  },

  async addr(args) {
    // addr NAME — print the pointer handle for a variable (array or
    // scalar): `addr a` → `\u0001mem:a:0`. The C frontend's pointer seam
    // (memLoad/memStore/memAdvance) walks shell arrays through these
    // handles — `sum_first "$(addr a)" 3` reads a[0..2] from a sourced
    // C function. A handle is opaque (a pointer is a string, never
    // self-describing); forging one is unsupported.
    const name = String(args[0] ?? "");
    if (!name || /[^A-Za-z0-9_]/.test(name)) {
      process.stderr.write("addr: usage: addr NAME (a variable name)\n");
      return 1;
    }
    const h = (otRt && otRt.sh2 && otRt.sh2.memAddrOf)
      ? otRt.sh2.memAddrOf(name)
      : "\u0001mem:" + name + ":0";
    process.stdout.write(h + "\n");
    return 0;
  },

  async find(args) {
    // TWO finds under one name, dispatched on the first argument's shape:
    //   find UTF8_STRING…          → the directory search below
    //   find \u0001mem:… …         → a sourced C find() over a pointer tree
    // (a mem handle is the opaque \u0001mem:<id>:<offset> string; route it
    // to the function table, where the transpiled C find walks the list).
    if (process.env.SH2_DEBUG_FIND) process.stderr.write(`[find] arg0=${JSON.stringify(String(args[0] ?? ""))} hasFn=${otRt && otRt.sh2 && otRt.sh2.functions ? otRt.sh2.functions.has("find") : "no-otRt"}\n`);
    if (String(args[0] ?? "").includes("\u0001mem:") &&
        otRt && otRt.sh2 && otRt.sh2.functions && otRt.sh2.functions.has("find")) {
      const v = await otRt.sh2.fnCall("find", args);
      return (v === false ? 1 : (v === true || v === undefined ? 0 : Number(v) || 0));
    }
    // find [path...] [expression]
    //   -name PATTERN    match basename, * and ? wildcards (repeatable, AND)
    //   -iname PATTERN   case-insensitive -name
    //   -type f|d        match files or directories
    //   -maxdepth N      descend at most N levels below the start points
    //   -mindepth N      don't apply tests above level N (default 0)
    //   -print           print matching paths (default action)
    const paths = [];
    const namePatterns = [];      // { re } — all must match (AND)
    const types = new Set();
    let maxDepth = Infinity, minDepth = 0;
    let print = true;

    // Remote mounts would require crawling the network; refuse that and
    // only match them when a specific file is named.
    const REMOTE = ["/http/", "/github/", "/mount/github/", "/gitlab/", "/mount/gitlab/", "/git/", "/mount/git/"];
    const isRemote = (p) => REMOTE.some(pre => p === pre.slice(0, -1) || p.startsWith(pre));

    // Build a regex from a shell glob (* and ? wildcards)
    const globToRe = (glob, caseInsensitive) => {
      let reStr = "";
      for (const ch of glob) {
        if (ch === "*") reStr += ".*";
        else if (ch === "?") reStr += ".";
        else reStr += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp("^" + reStr + "$", caseInsensitive ? "i" : "");
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-name" || a === "-iname") {
        if (i + 1 >= args.length) {
          process.stderr.write(`find: missing argument to '${a}'\n`);
          return;
        }
        namePatterns.push({ re: globToRe(args[++i], a === "-iname") });
      } else if (a === "-type") {
        if (i + 1 >= args.length) {
          process.stderr.write(`find: missing argument to '-type'\n`);
          return;
        }
        const t = args[++i];
        if (t !== "f" && t !== "d") {
          process.stderr.write(`find: unknown type '${t}' (use 'f' for file or 'd' for directory)\n`);
          return;
        }
        types.add(t);
      } else if (a === "-maxdepth" || a === "-mindepth") {
        if (i + 1 >= args.length) {
          process.stderr.write(`find: missing argument to '${a}'\n`);
          return;
        }
        const n = parseInt(args[++i], 10);
        if (isNaN(n) || n < 0) {
          process.stderr.write(`find: invalid depth '${args[i]}'\n`);
          return;
        }
        if (a === "-maxdepth") maxDepth = n;
        else minDepth = n;
      } else if (a === "-print") {
        print = true;
      } else if (a === "--") {
        // Everything after -- is a start path
        for (const rest of args.slice(i + 1)) paths.push(rest);
        break;
      } else if (a.startsWith("-")) {
        process.stderr.write(`find: unknown option '${a}'\n`);
        return;
      } else {
        paths.push(a);
      }
    }

    if (paths.length === 0) paths.push(".");

    // Do tests apply at this depth? (-mindepth/-maxdepth gate traversal
    // too, so we never descend past -maxdepth)
    const matched = (name, type, depth) => {
      if (depth < minDepth) return false;
      if (types.size > 0 && !types.has(type)) return false;
      for (const p of namePatterns) {
        if (!p.re.test(name)) return false;
      }
      return true;
    };

    let skippedRemote = false;

    // Recursive walk. `dir` is a resolved absolute path; `depth` is the
    // depth of `dir` itself (start points are depth 0).
    const walk = async (dir, depth) => {
      if (isRemote(dir)) {
        hadError = true;
        if (!skippedRemote) {
          process.stderr.write(`find: skipping remote mount ${dir} (name specific files to search them)\n`);
          skippedRemote = true;
        }
        return;
      }
      let entries;
      try { entries = await fs.list(dir); } catch (e) {
        hadError = true;
        process.stderr.write(`find: ${dir}: ${e.message}\n`);
        return;
      }
      for (const entry of entries) {
        const isDir = entry.endsWith("/");
        const name = isDir ? entry.slice(0, -1) : entry;
        const full = (dir === "/" ? "/" : dir + "/") + name;
        let st = null;
        try { st = await fs.stat(full); } catch { /* fall back to entry form */ }
        const type = isDir || (st && st.type === "dir") ? "d" : "f";
        if (matched(name, type, depth + 1) && print) {
          process.stdout.write(full + (type === "d" ? "/" : "") + "\n");
        }
        if (type === "d" && depth + 1 < maxDepth) {
          await walk(full, depth + 1);
        }
      }
    };

    let hadError = false;
    const seen = new Set();
    for (const path of paths) {
      const r = fs._resolve(path);
      if (seen.has(r)) continue;
      seen.add(r);
      let st;
      try { st = await fs.stat(r); } catch (e) {
        hadError = true;
        process.stderr.write(`find: ${path}: ${e.message}\n`);
        continue;
      }
      const type = st.type === "dir" ? "d" : "f";
      const base = r.split("/").pop() || "/";
      if (matched(base, type, 0) && print) {
        process.stdout.write((r === "/" ? "/" : r + (type === "d" ? "/" : "")) + "\n");
      }
      if (type !== "d") continue;
      if (isRemote(r)) {
        hadError = true;
        process.stderr.write(`find: skipping remote mount ${r} (name specific files to search them)\n`);
        continue;
      }
      if (0 < maxDepth) await walk(r, 0);
    }
    return hadError ? 1 : 0;
  },

  async mount(args) {
    // mount                              — list current mounts
    // mount github:user/repo /mymount    — attach a GitHub repo at a path
    // mount --help                       — usage
    if (args.length === 0 || args[0] === "-l" || args[0] === "--list") {
      process.stdout.write(fs.mountTable());
      return 0;
    }
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`mount — attach a remote repo as a filesystem

mount                          list mounted filesystems
mount github:user/repo /path   mount a GitHub repo at /path
unmount /path                  detach a user-created mount

Example:
  mount github:gmatht/sh2perl /mymount
  ls /mymount
  cat /mymount/README.md
`);
      return 0;
    }
    if (args[0] === "--bind") {
      // mount --bind <src> <dst> — re-expose one directory at another
      // path. Admin-only: an unprivileged user could otherwise bind a
      // directory over a protected one and bypass permissions.
      if (!isPrivilegedUser()) {
        process.stderr.write("mount: operation not permitted (admin only)\n");
        return 1;
      }
      const bindSrc = args[1];
      const bindDst = args[2];
      if (!bindSrc || !bindDst) {
        process.stderr.write("mount: usage: mount --bind <src> <dst>\n");
        return 2;
      }
      const sr = fs._resolve(bindSrc);
      const dr = fs._resolve(bindDst);
      if (fs.mounts.some((m) => m.prefix === dr)) {
        process.stderr.write(`mount: ${dr}: already a mount point (unmount ${dr} first)\n`);
        return 1;
      }
      try {
        fs.bindMount(sr, dr);
        process.stdout.write(`mounted ${bindSrc} on ${bindDst} (bind)\n`);
        return 0;
      } catch (e) {
        process.stderr.write(`mount: ${e.message}\n`);
        return 1;
      }
    }
    const spec = args[0];
    const target = args[1];
    if (!target) {
      process.stderr.write(`mount: usage: mount github:user/repo /mymount · mount --bind <src> <dst>\n`);
      return 2;
    }
    if (args.length > 2) {
      process.stderr.write(`mount: too many arguments\n`);
      return 2;
    }
    const r = fs._resolve(target);
    if (fs.mounts.some((m) => m.prefix === r)) {
      process.stderr.write(`mount: ${r}: already a mount point (unmount ${r} first)\n`);
      return 1;
    }
    try {
      const record = fs.mountSpec(spec, r);
      process.stdout.write(`mounted ${record.name} at ${record.prefix}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`mount: ${e.message}\n`);
      return 1;
    }
  },

  async unmount(args) {
    // unmount /mymount — detach a user-created mount
    if (!args[0] || args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`unmount — detach a user-created mount

unmount /mymount
`);
      return 0;
    }
    const target = args[0];
    try {
      const r = fs._resolve(target);
      const removed = fs.unmount(r);
      process.stdout.write(`unmounted ${removed.prefix} (${removed.name})\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`unmount: ${target}: ${e.message}\n`);
      return 1;
    }
  },

  async wasmer(args) {
    // wasmer list | install <pkg> | search <term> — WASM package
    // manager. The browser fetches the same prebuilt binaries over
    // HTTP; the CLI reads them from the repo's www/wasm-bin/ dir.
    if (!args[0] || args[0] === "help") {
      process.stdout.write(`wasmer — WASM package manager for browser shell

wasmer list                    — list available packages
wasmer search <term>           — search packages
wasmer install <name>          — copy package to /usr/bin/
wasmer help                    — this help

Packages are pre-compiled wasm32-wasi binaries served from
www/wasm-bin/ (see build-wasm-grep.sh, build-wasm-cproc.sh).
Once installed they run as native commands:
  wasmer install grep
  echo "hello" | grep hello
`);
      return 0;
    }
    if (args[0] === "list") {
      for (const { name, desc } of wasmerReg.list()) {
        process.stdout.write(`  ${name.padEnd(12)} ${desc}\n`);
      }
      return 0;
    }
    if (args[0] === "search") {
      const results = wasmerReg.search(args[1] || "");
      if (results.length === 0) {
        process.stdout.write(`No packages match "${args[1]}".\n`);
        return 1;
      }
      for (const { name, desc } of results) {
        process.stdout.write(`  ${name.padEnd(12)} ${desc}\n`);
      }
      return 0;
    }
    if (args[0] === "install") {
      const name = args[1];
      if (!name) {
        process.stderr.write("wasmer: install needs a package name\n");
        return 2;
      }
      if (!wasmerReg.list().some((p) => p.name === name)) {
        process.stderr.write(`wasmer: Package '${name}' not found. Try 'wasmer list' first.\n`);
        return 1;
      }
      let buf;
      try {
        const { readFile } = await import("node:fs/promises");
        buf = await readFile(new URL(`../www/wasm-bin/${name}.wasm`, import.meta.url));
      } catch {
        process.stderr.write(`wasmer: ${name}.wasm not built — run the repo's build script (e.g. ./build-wasm-grep.sh)\n`);
        return 1;
      }
      const destPath = `/usr/bin/${name}.wasm`;
      await fs.writeBlob(destPath, new Blob([buf]));
      process.stdout.write(`Installed ${name} → ${destPath} (${buf.length} bytes)\n`);
      return 0;
    }
    process.stderr.write(`wasmer: unknown command '${args[0]}' (list, install, search, help)\n`);
    return 2;
  },

  async go(args) {
    // go run main.go [args…] — the REAL Go toolchain (cmd/compile +
    // cmd/link, cross-compiled to GOOS=js GOARCH=wasm) running in the
    // shell. See src/go.js and build-wasm-go.sh.
    return await goCmd(args);
  },

  async nethack(args) {
    // nethack [--demo] — real NetHack 3.6.7 (emscripten WASM) via
    // win/shim window system. Browser: full-screen TTY game. CLI:
    // --demo autoplays headlessly. See src/nethack.js.
    return await nethackCmd(args);
  },

  async jobs(args) {
    // jobs — list background jobs (&): [id] pid status cmd
    const list = getBgJobs().list();
    if (list.length === 0) {
      process.stdout.write("jobs: no background jobs\n");
      return 0;
    }
    for (const j of list) {
      const status = j.running ? "running"
        : j.killed ? "killed"
        : j.code === 0 ? "done"
        : `failed (${j.code})`;
      process.stdout.write(`[${j.id}] ${j.pid}  ${status.padEnd(14)} ${j.cmd}${j.minimized ? "  (minimized)" : ""}\n`);
    }
    return 0;
  },

  async wait(args) {
    // wait [id|pid] — wait for a background job, or all of them
    if (args.length > 1) {
      process.stderr.write("wait: too many arguments\n");
      return 2;
    }
    const code = await getBgJobs().wait(args[0]);
    if (code === 127 && args[0] !== undefined) {
      process.stderr.write(`wait: no such job '${args[0]}'\n`);
    }
    return code;
  },

  async kill(args) {
    // kill <id|pid> — terminate a background job (exit 137); dismiss a
    // finished one from the job table
    if (args.length !== 1) {
      process.stderr.write("kill: usage: kill <job-id|pid>\n");
      return 2;
    }
    const code = getBgJobs().kill(args[0]);
    if (code === 127) process.stderr.write(`kill: no such job '${args[0]}'\n`);
    return code;
  },

  async bash2js(args) {
    // bash2js 'echo hello'  — transpile bash source to JavaScript
    // bash2js -f file.sh    — transpile a file from the VFS
    // bash2js < script.sh   — transpile from a pipe
    //
    // The whole pipeline runs in the browser:
    //   bash → ESTree (debashcl.wasm, the debashc reactor) → JS (sh2.* runtime)
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`bash2js — transpile bash to JavaScript (runs entirely in the browser)

Usage:
  bash2js 'echo hello world'   transpile an inline bash script
  bash2js -f script.sh         transpile a file from the virtual FS
  cat script.sh | bash2js      transpile from a pipe

Pipeline:  bash → ESTree (debashcl.wasm) → JS (sh2.* runtime)
The generated JS targets the sh2.* runtime + env; save it to a .js file
and run it as a command.
`);
      return 0;
    }
    let source = null;
    if (args[0] === "-f" || args[0] === "--file") {
      const file = args[1];
      if (!file) {
        process.stderr.write("bash2js: -f needs a file name\n");
        return 2;
      }
      try {
        source = await fs.read(file);
      } catch (e) {
        process.stderr.write(`bash2js: ${file}: ${e.message}\n`);
        return 1;
      }
    } else if (args.length === 0 || args[0] === "-") {
      if (stdinBuffer) {
        source = stdinBuffer; // piped in
      } else {
        process.stderr.write("bash2js: no script given (pass one as an argument, -f FILE, or pipe it in)\n");
        return 2;
      }
    } else if (args.length === 1 && !args[0].startsWith("-")) {
      // A single bare arg: existing file → transpile it; otherwise inline source.
      try {
        source = await fs.read(args[0]);
      } catch {
        source = args[0];
      }
    } else {
      source = args.join(" ");
    }
    try {
      const { js } = await bashToJS(fs, source);
      process.stdout.write(js);
      return 0;
    } catch (e) {
      process.stderr.write(`bash2js: ${e.message}\n`);
      return 1;
    }
  },

  async bash(args) {
    // bash 'echo hello world' — transpile AND execute bash source
    // bash script.sh          — execute a bash script from the VFS
    // bash -c 'echo hi'       — same as inline (-c accepted for familiarity)
    // cat script.sh | bash    — execute from a pipe
    //
    // Type bash, get generated JS executed:
    //   bash → ESTree (debashcl.wasm) → JS (sh2.* runtime) → run in the shell
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`bash — run bash commands by transpiling them to JS

Usage:
  bash 'echo hello world'  transpile + execute inline bash
  bash -c 'echo hi'        same as inline
  bash script.sh           execute a bash script file from the virtual FS
  cat script.sh | bash     execute from a pipe
  bash -                   execute from a pipe (explicit)
    bash                     interactive REPL (state persists per line)

Pipeline:  bash → ESTree (debashcl.wasm) → JS (sh2.* runtime) → executed
Loops, conditionals, variables, arithmetic and pipes work:
  bash 'for i in 1 2 3; do echo $i; done'
  bash 'x=1; while [ $x -lt 3 ]; do echo $x; x=$((x+1)); done'
  bash 'echo hi | grep h'
`);
      return 0;
    }
    let source = null;
    if (args[0] === "-c" || args[0] === "-e") {
      source = args.slice(1).join(" ");
    } else if (args[0] === "-f" || args[0] === "--file") {
      const file = args[1];
      if (!file) {
        process.stderr.write("bash: -f needs a file name\n");
        return 2;
      }
      try {
        source = await fs.read(file);
      } catch (e) {
        process.stderr.write(`bash: ${file}: ${e.message}\n`);
        return 1;
      }
    } else if (args.length === 0 || args[0] === "-") {
      if (stdinBuffer) {
        source = stdinBuffer; // piped in
      } else if (args.length === 0) {
        // bare `bash` with no pipe → an interactive REPL
        enterBashRepl();
        return 0;
      } else {
        process.stderr.write("bash: no script given (pass one as an argument, use -f FILE, or pipe it in)\n");
        return 2;
      }
    } else if (!args[0].startsWith("-")) {
      // A file name runs the script from the VFS (`bash script.sh`);
      // anything else is inline bash source (`bash 'echo hi'`).
      // A word that looks like a script path but doesn't exist is an
      // error; multi-word source (paths inside it, like `if [ -f /x`) is
      // always treated as inline bash.
      const file = args[0];
      let fileSource = null;
      try {
        fileSource = await fs.read(file);
      } catch {
        // not a file — fall through to inline source
      }
      const looksLikePath = !/\s/.test(file) && (file.includes("/") || /\.sh$/.test(file));
      if (fileSource !== null) {
        source = fileSource;
      } else if (looksLikePath) {
        process.stderr.write(`bash: ${file}: No such file or directory\n`);
        return 1;
      } else {
        // Inline source: the first arg is the script; the rest are the
        // positional parameters ($1, $2, ...) like `bash -c '...' a b`.
        source = args[0];
      }
    } else {
      source = args.join(" ");
    }
    try {
      const scriptArgs = args[0] === "-c" || args[0] === "-e" ? args.slice(1) : args.slice(1);
      // C functions sourced earlier live in the persistent otRt (the
      // fresh runBash runtime dispatches to it natively) — give the
      // otRt this command's pipe input FIRST, so their getline/
      // read_line bridge sees it.
      if (otRt && otRt.sh2) { try { otRt.sh2.stdin = stdinBuffer || ""; } catch {} }
      return await runBash(fs, source, {
        wasmRunner,
        stdout: process.stdout,
        stderr: process.stderr,
        runCmd: runNestedCommand,
        args: scriptArgs,
        argv0: args[0] && !args[0].startsWith("-") ? args[0] : "bash",
        stdin: stdinBuffer || "",
      });
    } catch (e) {
      if (e instanceof InterruptError) throw e;
      process.stderr.write(`bash: ${e.message}\n`);
      return 1;
    }
  },

  async which(args) {
    // which cmd... — print the path (or builtin) the shell would run
    // for each command name, like POSIX `which`. Lookup is the same
    // as command resolution (wasm binary → builtin → .js/.mjs/.wasm
    // files in $PATH) but without the auto-download side effect.
    if (args.length === 0) {
      process.stderr.write("which: missing operand\n");
      return 2;
    }
    let missing = false;
    for (const name of args) {
      const resolved = await findCommand(name);
      if (!resolved) {
        missing = true;
        process.stderr.write(`which: no ${name} in (${env.PATH})\n`);
        continue;
      }
      if (resolved.type === "builtin") {
        process.stdout.write(`${name}: shell builtin\n`);
      } else {
        process.stdout.write(resolved.path + "\n");
      }
    }
    return missing ? 1 : 0;
  },

  async man(args) {
    // man [command]       — show the manual page for a command
    // man -k <keyword>    — search manual pages (like apropos)
    // man                 — index of all manual pages
    if (args.length === 0) {
      process.stdout.write("Manual pages available in this shell:\n\n");
      for (const line of manIndex()) process.stdout.write("  " + line + "\n");
      process.stdout.write(`\nUse "man <command>" for a command's page, "man -k <word>" to search.\n`);
      return 0;
    }
    if (args[0] === "-k" || args[0] === "--apropos") {
      const term = args[1];
      if (!term) {
        process.stderr.write("man: what manual page do you want? (man -k <keyword>)\n");
        return 2;
      }
      const results = searchManPages(term);
      if (results.length === 0) {
        process.stdout.write(`Nothing appropriate for "${term}".\n`);
        return 1;
      }
      for (const line of results) process.stdout.write("  " + line + "\n");
      return 0;
    }
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(MAN_PAGES.man + "\n");
      return 0;
    }
    if (args.length > 1 && args[0] !== "-k") {
      process.stderr.write(`man: too many arguments (try: man <command> or man -k <keyword>)\n`);
      return 2;
    }
    const page = await getManPage(args[0], { fs, wasmerReg });
    if (!page) {
      process.stderr.write(`man: no manual entry for ${args[0]}\n`);
      process.stderr.write(`(see the index: "man" alone, or search with "man -k <keyword>")`);
      process.stderr.write("\n");
      return 1;
    }
    process.stdout.write(page.text + "\n");
    return 0;
  },

  async help(args) {
    process.stdout.write(`jtsh — minimal shell for the virtual filesystem

Built-in commands:
  ls [dir]        List directory contents (ls -l: long format)
  cat <file>...   Print file contents
  echo <text>     Print text
  pwd             Print working directory
  cd [dir]        Change directory
  export [N=V]... Set environment variables (export NAME prints all)
  rm <file>...    Remove files
  mkdir <dir>...  Create directories
  cp <src> <dst>  Copy files
  mv <src> <dst>  Move files
  ln [-s] [-f] TARGET LINK  Create a symbolic link (ln -s target dir/ links inside dir)
  readlink <file>...  Print symlink targets
  head [-n N] [file...]  Print first N lines (default 10; stdin if no file)
  tail [-n N] [file...]  Print last N lines (default 10; stdin if no file)
  grep [opts] <pattern> [file...]  Search files/stdin for pattern
                 (-i ignore case · -n line numbers · -v invert · -c count
                  -l files with matches · -r recursive · -e PATTERN)
  find [path...] [expr]  Find files by name/type
                 (-name PAT · -iname PAT · -type f|d · -maxdepth N · -mindepth N)
  mount [github:user/repo /path]  List mounts, or attach a GitHub repo at a path
  unmount <path>   Detach a user-created mount
  wasmer          WASM package manager (list / install <pkg> / search <term>)
  go              Run/build Go programs — the real Go toolchain as WASM
                  (go run main.go · go build main.go · go version · man go)
  nethack         Play NetHack 3.6.7 — the real game, compiled to WASM
                  (browser: full-screen TTY · CLI: nethack --demo autoplays · man nethack)
  jobs            List background jobs (&) · wait [id] · kill <id>
                  (cmd & runs in the background; browser: right-hand panel)
  bash2js         Transpile bash to JavaScript (debashcl ESTree)
  bash            Run bash commands: transpile to JS and execute
                  (bash 'echo hi' · bash script.sh · cat s.sh | bash)
  cmd.exe         Run Windows batch: transpile to JS and execute (bat2js)
                  (cmd.exe 'echo hi' · cmd.exe /c 'echo hi' · x.bat | cmd.exe)
  true            Always succeeds (exit 0)
  false           Always fails (exit 1)
  which <cmd>...  Show the path (or builtin) the shell would run
                  (wasm binary → builtin → .js/.mjs/.wasm files in $PATH)
  man [cmd]       Manual page for a command (man alone: index;
                  man -k <word>: search pages, like apropos)
  bug            File a bug report as a GitHub issue (terminal context +
                  what you expected; man bug · triage: ./bug-triage.sh)
  help            This help
  exit            Exit the shell
  source <file>   Run a file in the current shell (.c/.sh/.zsh/.fish/…)
  . <file>        Same as source

Startup config (~/.jtshrc):
  $HOME/.jtshrc is read at startup (interactive mode); each line
  runs as a shell command, '#' starts a comment.
    export EDITOR=edit
    echo "Welcome back"
  (in the browser, edit it with: edit ~/.jtshrc)

Pipes: cmd1 | cmd2 — cmd1's stdout becomes cmd2's stdin
  Example: cat README.md | head -3
  Example: echo "hello" | grep -i hello
  Example: find /home -name *.txt | head -5

Conditionals: cmd1 && cmd2 — run cmd2 only if cmd1 succeeded (exit 0)
              cmd1 || cmd2 — run cmd2 only if cmd1 failed (non-zero exit)
  Example: grep TODO README.md || echo "no TODOs"
  Example: cat x.js && echo ok || echo failed
  (A command's exit status: 0 success · 1 failure · 2 usage error · 127 not found)

Keys:
  Ctrl+C           — interrupt the running command (exit status 130, like SIGINT)
                     or cancel the current line at an idle prompt
  Ctrl+D           — exit the shell (at an empty prompt)

Aliases: vi/vim/nano = edit · less/more = cat · cls = clear
         dir = ls · ? = help · q/quit = exit
         apt/yum/brew/pip = wasmer (WASM packages)

Environment variables:
  $PATH  /bin:/usr/bin   command search path
  $HOME  /home                     default directory (bare cd goes there)
  $USER  jtsh                    current user
  $PWD   current directory
  Expand with $NAME or \${NAME}: echo $HOME · cd $HOME · cat $HOME/examples/note.txt
  (single quotes or a \$ keep the $ literal: echo '$HOME' prints $HOME)

Any other command runs a .js file from the command path, and a command
containing a / runs that exact file, like /bin/sh:
  ./a.wasm            run a compiled wasm binary in the cwd
  /home/x.js          run a script by absolute path
  ../tool.mjs         or any relative path
  (exit status 126 if the file exists but isn't .js/.mjs/.wasm)
Write new commands by creating .js files in /bin/.
`);
  },

  async chmod(args) {
    // chmod OCTAL file... — only the owner (or jtsh/root) may change a
    // file's mode. Modes are Unix-style: 600 = owner rw, 644 = +other r,
    // 755 = dir default, 700 = private dir.
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
      process.stderr.write("chmod OCTAL file...  (e.g. chmod 600 secret.txt · chmod 755 dir)\n");
      return args.length ? 0 : 2;
    }
    if (!/^[0-7]{3,4}$/.test(args[0])) {
      process.stderr.write(`chmod: invalid mode '${args[0]}' — use octal (600, 644, 755)\n`);
      return 2;
    }
    const mode = parseInt(args[0], 8);
    const user = env.USER || "jtsh";
    let hadError = false;
    for (const file of args.slice(1)) {
      const a = fs.attrOf(file);
      if (!a) {
        process.stderr.write(`chmod: ${file}: No such file or directory\n`);
        hadError = true;
        continue;
      }
      if (user !== "jtsh" && user !== "root" && user !== a.owner) {
        process.stderr.write(`chmod: ${file}: operation not permitted (owned by ${a.owner})\n`);
        hadError = true;
        continue;
      }
      fs.setAttr(file, { owner: a.owner, mode });
    }
    return hadError ? 1 : 0;
  },

  async whoami(args) {
    process.stdout.write((env.USER || "jtsh") + "\n");
    return 0;
  },

  async su(args) {
    // su                  → drop to nobody (unprivileged)
    // su <name>           → switch to that user (su jtsh / su root → back)
    let target = (args[0] || "nobody").trim().toLowerCase();
    if (target === "-") target = "nobody";
    if (!/^[a-z_][a-z0-9_-]*$/.test(target)) {
      process.stderr.write(`su: invalid user name '${target}'\n`);
      return 1;
    }
    if (env.USER === target) {
      process.stdout.write(`su: already running as ${target}\n`);
      return 0;
    }
    if (!suState.prev) {
      suState.prev = { user: env.USER, home: env.HOME, cwd: fs.cwd };
    }
    env.USER = target;
    const home = target === "jtsh" ? "/home" : "/home/" + target;
    env.HOME = home;
    try {
      await fs.stat(home);
    } catch {
      try {
        await fs.write(home + "/README.txt",
          `Welcome, ${target}!\n` +
          `This is your home directory (${home}).\n` +
          `You are ${target === "nobody" ? "an unprivileged user" : "running as " + target} on jtsh.\n` +
          `Run 'su jtsh' to return to the admin account.\n`);
      } catch {}
    }
    // The new home is owned by the target user (su runs as admin, so
    // the writes above would otherwise attribute it to jtsh — leaving
    // the account unable to write in its own home).
    fs.setAttr(home, { owner: target, mode: 0o700 });
    try { fs.setAttr(home + "/README.txt", { owner: target, mode: 0o644 }); } catch {}
    if (target === "jtsh" && suState.prev) {
      fs.cwd = suState.prev.cwd;
      suState.prev = null;
    } else {
      fs.cwd = home;
    }
    env.PWD = fs.cwd;
    const unpriv = ["nobody", "daemon", "guest", "www-data"].includes(target);
    process.stdout.write(`su: switched to ${target} — ${unpriv ? "unprivileged" : "user"}\n`);
    process.stdout.write(`    HOME=${env.HOME} · run 'su jtsh' to return\n`);
    rl.setPrompt(shellPrompt());
    rl.prompt();
    return 0;
  },

  async chroot(args) {
    // chroot <dir>   — confine the shell to a new root (admin only)
    // chroot -       — return to the real root
    if (!isPrivilegedUser()) {
      process.stderr.write("chroot: operation not permitted (admin only)\n");
      return 1;
    }
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
      process.stdout.write("chroot <dir> — confine the shell to a new root\n");
      process.stdout.write("chroot -      — return to the real root\n");
      return args.length ? 0 : 2;
    }
    if (args[0] === "-" || args[0] === "/") {
      if (fs.root && fs.root !== "/") {
        fs.cwd = fs.chrootSavedCwd || "/home";
        fs.root = "/";
        process.stdout.write("chroot: returned to the real root\n");
      } else {
        process.stdout.write("chroot: not inside a chroot\n");
      }
      rl.setPrompt(shellPrompt());
      rl.prompt();
      return 0;
    }
    const r = fs._resolve(args[0]);
    let st;
    try { st = await fs.stat(r); } catch (e) {
      process.stderr.write(`chroot: ${args[0]}: ${e.message}\n`);
      return 1;
    }
    if (!st || st.type !== "dir") {
      process.stderr.write(`chroot: ${args[0]}: not a directory\n`);
      return 1;
    }
    fs.chrootSavedCwd = fs.cwd;
    fs.root = r;
    fs.cwd = r;
    process.stdout.write(`chroot: changed root to ${args[0]} — "/" is now ${r}\n`);
    rl.setPrompt(shellPrompt());
    rl.prompt();
    return 0;
  },

  async exit(args) {
    process.exit(0);
  },

  // `source file` / `. file` — run a file in the CURRENT shell context
  // (bash's source): reads the file, transpiles it through the unified
  // pipeline (sh/zsh in-process; fish/c/go/py/pl via the merged busybox
  // frontend) → estree → JS, runs it in the persistent REPL runtime and
  // harvests the variables it set back into the shell.
  async source(args) {
    if (args.length === 0) {
      process.stderr.write("source: filename argument required\n");
      return 2;
    }
    const file = args[0];
    const base = fs.cwd !== undefined ? fs.cwd : "/";
    const resolved = file.includes("/") ? fs._resolve(file) : fs._resolve(base + "/" + file);
    let content;
    try {
      // read() first (full mount resolution); fall back to readBlob
      // (the cat path) for writable mounts the read wrapper misses.
      try {
        content = await fs.read(resolved);
      } catch {
        content = String(await (await fs.readBlob(resolved)).text());
      }
    } catch (e) {
      process.stderr.write(`source: ${file}: ${e.message}\n`);
      return 1;
    }
    const lang = sourceLangOf(resolved);
    try {
      return await runSourceContent(content, lang, args.slice(1));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      process.stderr.write(`source: ${file}: ${msg}\n`);
      return 1;
    }
  },
  async qsort(args) {
    // qsort ARRAY COMPARFN — sort a shell array IN PLACE using a bash
    // function as the comparator (C qsort convention: the function is
    // called as COMPARFN "$a" "$b" and must echo a signed number —
    // -1/0/1 — to stdout). No wasm needed: the shell arrays and the
    // function table both live in the JS runtime.
    //   a=(pear apple fig banana)
    //   alphabetic_compare() { if [[ "$1" < "$2" ]]; then echo -1
    //                          elif [[ "$1" > "$2" ]]; then echo 1
    //                          else echo 0; fi }
    //   qsort a alphabetic_compare; echo "${a[@]}"  → apple banana fig pear
    const help = () => process.stdout.write(
      `qsort ARRAY COMPARFN — sort a shell array in place using a bash function
` +
      `  as the comparator (C qsort convention). COMPARFN is called with two
` +
      `  elements as $1/$2 and must ECHO a signed number (-1/0/1) to stdout.
` +
      `
  a=(pear apple fig banana)
` +
      `  alphabetic_compare() { if [[ "$1" < "$2" ]]; then echo -1; \\
` +
      `                           elif [[ "$1" > "$2" ]]; then echo 1; \\
` +
      `                           else echo 0; fi }
` +
      `  qsort a alphabetic_compare; echo "\${a[@]}"
`
    );
    if (!args.length || args[0] === "-h" || args[0] === "--help") { help(); return 0; }
    const name = args[0], compar = args[1];
    if (!compar) { process.stderr.write("qsort: usage: qsort ARRAY COMPARFN\n"); return 2; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      process.stderr.write(`qsort: '${name}': not a valid variable name\n`);
      return 2;
    }
    await ensureOtRuntime();
    const sh2 = otRt.sh2;
    if (!sh2.functions || !sh2.functions.has(compar)) {
      process.stderr.write(`qsort: no function '${compar}' (define it first: ${compar}() { … })\n`);
      return 1;
    }
    const arr = sh2.vars[name];
    if (process.env.QSORT_DEBUG) process.stderr.write(`QSORT_DEBUG vars.${name}=${JSON.stringify(arr)} typeof=${typeof arr} isArr=${Array.isArray(arr)} env.${name}=${JSON.stringify(env[name])}\n`);
    if (!Array.isArray(arr)) {
      process.stderr.write(`qsort: '${name}' is not an array\n`);
      return 1;
    }
    // The comparator is a real bash function. Its body may emit through
    // either the sh2.exec path or the native-direct process shim, so a
    // plain sh2.capture (mode-aware only) would miss one of them — swap
    // the write targets themselves around the call and read the chunks
    // back. Non-numeric output is treated as "equal" (0) — the C qsort
    // convention.
    const captureOut = async (fn) => {
      const chunks = [];
      const targets = [];
      if (typeof stdout !== "undefined" && stdout && typeof stdout.write === "function") targets.push(stdout);
      if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") targets.push(process.stdout);
      const saved = targets.map((t) => t.write);
      for (const t of targets) t.write = (s) => { if (s) chunks.push(s); return true; };
      try { await fn(); } finally { targets.forEach((t, i) => { t.write = saved[i]; }); }
      return chunks.join("");
    };
    const cmp = async (a, b) => {
      const out = await captureOut(() => sh2.fnCall(compar, [a, b]));
      const n = Number(String(out ?? "").trim());
      return Number.isFinite(n) ? n : 0;
    };
    // async quicksort (Lomuto partition, last element pivot) — the
    // compar must be awaited, so JS's sync Array.sort can't drive it.
    const qs = async (lo, hi) => {
      if (lo >= hi) return;
      const pivot = arr[hi];
      let i = lo;
      for (let j = lo; j < hi; j++) {
        if ((await cmp(arr[j], pivot)) <= 0) {
          const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
          i++;
        }
      }
      arr[hi] = arr[i]; arr[i] = pivot;
      await qs(lo, i - 1);
      await qs(i + 1, hi);
    };
    try {
      await qs(0, arr.length - 1);
    } catch (e) {
      process.stderr.write(`qsort: ${compar}: ${e.message}\n`);
      return 1;
    }
    sh2.setArray(name, arr);
    // The next transpiled line re-seeds the runtime from otVars/env —
    // plant the SORTED array as the persistent state, or the stale
    // pre-sort copy would clobber this write-back.
    otVars.set(name, arr);
    try { env[name] = arr.join(" "); } catch {}
    return 0;
  },
  async cmdExe(args) {
    // cmd.exe — run Windows batch by transpiling it to JS (bat2js).
    // The whole pipeline runs in the browser:
    //   .bat → A1 shIR (busybox's bat-sh-go frontend) → ESTree
    //   (otranspilerl) → JS (estree.js, sh2.* runtime) → executed
    // Usage mirrors `bash`, plus real cmd's /c and /k switches:
    //   cmd.exe 'echo hello'        transpile + execute inline batch
    //   cmd.exe /c 'echo hi'        run and exit (real cmd's /c)
    //   cmd.exe /k 'echo hi'        run then keep going (REPL)
    //   cmd.exe -f script.bat       execute a batch file from the VFS
    //   cmd.exe script.bat          execute a batch file (existing file)
    //   cat script.bat | cmd.exe    execute from a pipe
    //   cmd.exe --js 'echo hi'      print the generated JS (bat2js mode)
    //   cmd.exe                     interactive REPL (state persists per line)
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`cmd.exe — run Windows batch by transpiling it to JS

Usage:
  cmd.exe 'echo hello world'  transpile + execute inline batch
  cmd.exe /c 'echo hi'        same as inline, then exit (real cmd's /c)
  cmd.exe /k 'echo hi'        run, then keep going (interactive REPL)
  cmd.exe -f script.bat       execute a batch file from the virtual FS
  cmd.exe script.bat          execute a batch file (existing file wins)
  cat script.bat | cmd.exe    execute from a pipe
  cmd.exe --js 'echo hi'      print the generated JS only (bat2js mode)
  cmd.exe                     interactive REPL (state persists per line)

Pipeline:  .bat → A1 shIR (bat-sh-go frontend) → ESTree (otranspilerl)
           → JS (sh2.* runtime) → executed
Batch builtins map onto the shell's POSIX tools (type→cat, copy→cp,
copy→cp, del→rm, dir→ls, …); %var% is case-insensitive and %errorlevel%
reads the shell's $?. Unsupported batch (pipes, delayed expansion !var!,
setlocal, call other.bat, …) refuses loudly — see the frontend's v1 subset.
`);
      return 0;
    }
    let source = null;
    let toJsOnly = false;
    let keepOpen = false;   // /k — run the source, then enter the REPL
    let scriptArgs = [];    // %1..%9 for the batch script
    let argv0 = "cmd.exe";
    const pos = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "/c" || a === "-c") {
        source = args.slice(i + 1).join(" ");
        i = args.length;
        break;
      }
      if (a === "/k" || a === "-k") {
        source = args.slice(i + 1).join(" ");
        keepOpen = true;
        i = args.length;
        break;
      }
      if (a === "--js" || a === "--to-js") { toJsOnly = true; continue; }
      if (a === "-f" || a === "--file") {
        const file = args[++i];
        if (!file) {
          process.stderr.write("cmd.exe: -f needs a file name\n");
          return 2;
        }
        try {
          source = await fs.read(file);
        } catch (e) {
          process.stderr.write(`cmd.exe: ${file}: ${e.message}\n`);
          return 1;
        }
        argv0 = file;
        continue;
      }
      pos.push(a);
    }
    if (source === null) {
      if (pos.length === 0) {
        if (stdinBuffer) {
          source = stdinBuffer; // piped in
        } else if (args.length === 0 && process.stdin.isTTY) {
          // bare `cmd.exe` with no pipe → an interactive REPL
          enterCmdRepl();
          return 0;
        } else {
          process.stderr.write("cmd.exe: no script given (pass one as an argument, /c CMD, -f FILE, or pipe it in)\n");
          return 2;
        }
      } else {
        // A first-arg file name runs the batch file from the VFS
        // (`cmd.exe x.bat a b` — %1=a %2=b); anything else is inline
        // batch source (`cmd.exe 'echo hi'`). A word that looks like a
        // script path but doesn't exist is an error; multi-word source
        // is always treated as inline batch.
        const file = pos[0];
        let fileSource = null;
        try {
          fileSource = await fs.read(file);
        } catch {
          // not a file — fall through to inline source
        }
        const looksLikePath = !/\s/.test(file) && (file.includes("/") || /\.(bat|cmd)$/i.test(file));
        if (fileSource !== null) {
          source = fileSource;
          scriptArgs = pos.slice(1);
          argv0 = file;
        } else if (looksLikePath) {
          process.stderr.write(`cmd.exe: ${file}: No such file or directory\n`);
          return 1;
        } else {
          source = pos.join(" ");
        }
      }
    } else if (pos.length > 0) {
      // `-f FILE a b` — the trailing words are the script's %1..%9
      scriptArgs = pos;
    }
    try {
      if (toJsOnly) {
        const { batToJS } = await import("./bat2js.js");
        const { js } = await batToJS(fs, source);
        process.stdout.write(js);
        if (keepOpen) enterCmdRepl();
        return 0;
      }
      const { runBat } = await import("./bat2js.js");
      const code = await runBat(fs, source, {
        stdout: process.stdout,
        stderr: process.stderr,
        runCmd: runNestedCommand,
        args: scriptArgs,
        argv0,
      });
      if (keepOpen) enterCmdRepl();
      return code;
    } catch (e) {
      if (e instanceof InterruptError) throw e;
      process.stderr.write(`cmd.exe: ${e.message}\n`);
      return 1;
    }
  },
  "cmd.exe": async (args) => await builtins.cmdExe(args),
  cmd: async (args) => await builtins.cmdExe(args),
  ".": async (args) => await builtins.source(args),
};

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
function isPrivilegedUser() {
  const u = env.USER || "jtsh";
  return u === "jtsh" || u === "root";
}
function customExecDenied(path) {
  if (isPrivilegedUser()) return null;
  const a = fs.attrOf(path);
  const owner = a ? a.owner : "jtsh";
  if (owner === "jtsh") return null;
  return {
    type: "badpath",
    path,
    err: "operation not permitted: unprivileged users cannot run custom code (owned by " + owner + ")",
  };
}

// Mobile keyboards auto-capitalize the first letter of a sentence, so
// `Ls` and `ls` should be the same command. Exact-name matches always
// win; the fold only applies to bare command names (no "/") whose
// first letter is uppercase. `which Ls` benefits too.
async function findCommand(name) {
  const found = await findCommandExact(name);
  if (found) return found;
  if (!name.includes("/") && /^[A-Z]/.test(name)) {
    return await findCommandExact(name[0].toLowerCase() + name.slice(1));
  }
  // Lazy /bin command templates (www/bin/) — materialize on first use
  // (perl, lua, tar, zip, mail, …). Only bare names are auto-loaded.
  if (!name.includes("/")) {
    const p = await materializeBinCommand(name);
    if (p) return await findCommandExact(name);
  }
  return null;
}

async function findCommandExact(name) {
  if (name.includes("/")) {
    const resolved = fs._resolve(name);
    let st;
    try {
      st = await fs.stat(resolved);
    } catch {
      return null; // no such file
    }
    if (!st) return null;
    if (st.type === "dir") {
      return { type: "badpath", path: resolved, err: "Is a directory" };
    }
    if (/\.wasm$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "wasm", path: resolved };
    }
    if (/\\.(js|mjs)$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "file", path: resolved };
    }
    // .sh files (and files with a #! shebang line) run through the bash
    // transpiler — the shell's native format for bash scripts.
    if (/\.sh$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "sh", path: resolved };
    }
    // A #! shebang makes any reasonably-sized TEXT file runnable. Skip
    // known binary extensions, and never read a huge file just to look
    // at its first line (fs.read supports { limit }).
    if (st &&
        !/\.(jpg|jpeg|png|gif|webp|bmp|ico|mp3|mp4|ogg|webm|wav|zip|gz|tgz|wasm|pdf|ttf|otf|woff2?|bin|exe|jar|class)$/i.test(resolved) &&
        (!st.size || st.size < 1024 * 1024)) {
      try {
        const head = String(await fs.read(resolved, { limit: 256 }));
        const m = /^#!\s*(\S+)/.exec(head.split("\n")[0] || "");
        if (m) {
          const denied = customExecDenied(resolved);
          if (denied) return denied;
          return { type: "sh", path: resolved, shebang: m[1] };
        }
      } catch {}
    }
    // The file exists but the shell can't run it (no interpreter here).
    return {
      type: "badpath",
      path: resolved,
      err: "cannot execute: only .js/.mjs/.wasm files are runnable",
    };
  }

  const searchPaths = env.PATH.split(":").filter(Boolean);
  for (const dir of searchPaths) {
    try {
      const entries = await fs.list(dir);
      if (entries.includes(name + ".wasm")) {
        const p = dir + "/" + name + ".wasm";
        const denied = customExecDenied(p);
        if (denied) return denied;
        return { type: "wasm", path: p };
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  if (builtins[name]) return { type: "builtin", fn: builtins[name] };

  // A function defined by a sourced file / transpiled line (the
  // persistent otRt's sh2.functions map — bash's function table) shadows
  // commands, like in bash: `source fn.c` defining `testc()` then a bare
  // `testc` runs the body with the args as $1..$N.
  if (otRt && otRt.sh2 && otRt.sh2.functions && otRt.sh2.functions.has(name)) {
    return {
      type: "builtin",
      fn: async (args) => {
        const v = await otRt.sh2.fnCall(name, args);
        // the function may have mutated the runtime store (an in-place
        // sort/fill) — harvest it back so the next transpiled line's
        // seed sees the LIVE values, not a stale otVars snapshot.
        syncOtVarsFromStore();
        return (v === false ? 1 : (v === true || v === undefined ? 0 : Number(v) || 0));
      },
    };
  }

  // Walk the command path from $PATH (colon-separated, like POSIX)
  for (const dir of searchPaths) {
    try {
      const entries = await fs.list(dir);
      for (const entry of entries) {
        const clean = entry.replace(/\/$/, "");
        if (clean === name || clean === name + ".js") {
          const p = dir + "/" + clean;
          const denied = customExecDenied(p);
          if (denied) return denied;
          return { type: "file", path: p };
        }
        if (clean === name + ".mjs") {
          const p = dir + "/" + clean;
          const denied = customExecDenied(p);
          if (denied) return denied;
          return { type: "file", path: p };
        }
        if (clean === name + ".wasm") {
          const p = dir + "/" + clean;
          const denied = customExecDenied(p);
          if (denied) return denied;
          return { type: "wasm", path: p };
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }
  return null;
}

async function resolveCommand(name) {
  const found = await findCommand(name);
  if (found) return found;

  // Explicit paths are never auto-loaded — only bare command names
  // (cc, grep, python...) pull binaries from wasm-bin/ on first use.
  if (name.includes("/")) return null;

  // Auto-load a wasm binary from the local server's wasm-bin/ on first
  // use (cc is an alias for the compiler binary). Unprivileged users
  // never auto-load (and couldn't write to /usr/bin anyway).
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
  } catch {
    // Not available — fall through
  }
  return null;
}

// ─── Line Handler ───────────────────────────────────────────────

// Tokenize a pipeline segment into words the way a shell does:
//   whitespace separates words (outside quotes)
//   '...'  single quotes — everything literal until the closing quote
//   "..."  double quotes — backslash escapes only " \ $ and ` (POSIX),
//          everything else (spaces, |, *...) stays literal
//   \x     outside quotes — escapes the next character ("\ " → space)
//   "" / ''               — produce an empty word
// Throws an Error with a shell-style message if a quote is left open.
function tokenize(segment) {
  const tokens = [];
  let cur = "";
  let started = false;  // have we begun a word?
  let quoted = false;   // did this word contain an explicit quote? (so '' → "")
  let inSingle = false;
  let inDouble = false;

  const push = () => {
    if (started || quoted) tokens.push(cur);
    cur = "";
    started = false;
    quoted = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && ['"', "\\", "$", "`"].includes(segment[i + 1])) {
        cur += segment[++i]; // escaped char loses its special meaning
      } else if (ch === "$") {
        // $NAME / ${NAME} expansion (valid inside double quotes too)
        const ref = expandRef(segment, i);
        cur += ref.value;
        i = ref.end - 1;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'") { inSingle = true; started = true; quoted = true; continue; }
    if (ch === '"') { inDouble = true; started = true; quoted = true; continue; }
    if (ch === "\\") {
      if (i + 1 < segment.length) cur += segment[++i];
      started = true;
      continue;
    }
    if (ch === "~" && !started && !quoted) {
      // ~ / ~/path → $HOME / $HOME/path (tilde expansion)
      cur += env.HOME;
      started = true;
      continue;
    }
    if (ch === "$") {
      // $NAME / ${NAME} expansion outside quotes. The RESULT is
      // field-split on IFS (bash semantics): `x="a b"; echo $x` passes
      // two words. Quoted expansions (in the inDouble branch) never
      // split; a mid-word expansion (`pre$x`) appends unsplit.
      const ref = expandRef(segment, i);
      i = ref.end - 1;
      if (started) {
        cur += ref.value;
      } else {
        const ifs = env.IFS !== undefined ? String(env.IFS) : " \t\n";
        const val = String(ref.value);
        if (ifs === "" || val === "") {
          cur += val;
          started = true;
        } else {
          const cls = ifs.replace(/[\]\\^$.*+?{}()|[\]-]/g, "\\$&");
          const pieces = val.split(new RegExp("[" + cls + "]+")).filter((p) => p !== "");
          if (pieces.length === 0) continue;   // empty/unset var → no field (bash)
          for (let k = 0; k < pieces.length - 1; k++) tokens.push(pieces[k]);
          cur = pieces[pieces.length - 1];
          started = true;
        }
      }
      continue;
    }
    if (ch === ">") {
      // `>` is a metacharacter (bash-style): `echo 1>log` redirects to
      // log instead of echoing "1>log". Split it out of the word, and
      // treat ">>" as its own append-redirect token.
      push();
      if (segment[i + 1] === ">") { tokens.push(">>"); i++; }
      else tokens.push(">");
      continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
    started = true;
  }
  if (inSingle) throw new Error(`unexpected EOF while looking for matching "'"`);
  if (inDouble) throw new Error(`unexpected EOF while looking for matching '"'`);
  push();
  return tokens;
}

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
function syncOtVarsFromStore() {
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

// The A1 contract's Assign expr → literal value, or undefined when
// computed (Str → string; setArray Call → array of strings; anything
// else → the runtime diffs below harvest it if it materializes).
function a1LiteralValue(expr) {
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


// ─── runSourceContent: run a sourced file in the current shell ──
// The `source`/`.` core. Transpiles the file's language (sh/zsh in
// process; fish/c/go/py/pl via the merged busybox frontend) to the A1
// contract → estree → JS, then runs the generated JS in the SAME
// persistent otRt the REPL lines use and harvests the variables it set
// (A1 literal harvest + runtime/globalThis diff — the runEstreeProgram
// path). Positional args become $1..$9 inside the file.
// Extension → source language (mirrors the frontend testdata exts:
// py/.py, go/.go, c/.c, sh/.sh, pl/.pl, fish/.fish, zsh/.zsh). A
// non-.sh extensionless file defaults to sh, like bash's source.
function sourceLangOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? m[1].toLowerCase() : "";
  return { sh: "sh", zsh: "zsh", fish: "fish", c: "c", go: "go", py: "py", pl: "pl", perl: "pl", js: "js", bat: "bat" }[ext] || "sh";
}

// ─── runJsSourceContent: source a .js / .bat file as NATIVE JavaScript ──
// jtsh's native format is JS — this runs the file against the persistent
// runtime so `sh2.vars.X = …`, `sh2.functions.set("name", fn)` and bare
// global assignments survive the source. Returns the exit code.
async function runJsSourceContent(content, srcArgs) {
  await ensureOtRuntime();
  try { otRt.sh2.positional = (srcArgs && srcArgs.length ? srcArgs : getPositional()); } catch {}
  try { otRt.sh2.argv0 = getArgv0(); } catch {}
  const fn = new Function("fs", "env", "process", "sh2", `return (async () => { ${content} })();`);
  const beforeGlobals = new Set(Object.keys(globalThis));
  const beforeRtVars = new Set(Object.keys(otRt.sh2.vars));
  let v;
  try {
    v = await fn(fs, env, otProc, otRt.sh2);
  } catch (e) {
    if (e && e.exitCode !== undefined) return e.exitCode;  // `exit N`
    throw e;
  }
  // harvest bare global assignments (`x = 5` → globalThis.x) AND
  // sh2.vars writes (`sh2.vars.X = …`) into the shell's persistent state
  const keepable = (val) => typeof val === "string" || typeof val === "number" || Array.isArray(val);
  for (const k of Object.keys(otRt.sh2.vars)) {
    if (beforeRtVars.has(k) || isReadonly(k)) continue;
    const val = otRt.sh2.vars[k];
    if (keepable(val) && !k.startsWith("__")) otVars.set(k, Array.isArray(val) ? val : String(val));
  }
  for (const k of Object.keys(globalThis)) {
    if (beforeGlobals.has(k)) continue;
    const val = globalThis[k];
    if (keepable(val) && !k.startsWith("__")) otVars.set(k, Array.isArray(val) ? val : String(val));
    try { delete globalThis[k]; } catch {}
  }
  for (const [k, val] of otVars) {
    if (isReadonly(k)) continue;
    try { env[k] = Array.isArray(val) ? val.join(" ") : String(val); } catch {}
  }
  setShellStatus(v === false ? 1 : 0);
  return v === false ? 1 : 0;
}

async function runSourceContent(content, lang, srcArgs) {
  if (lang === "js") {
    return await runJsSourceContent(content, srcArgs);
  }
  // .bat goes through the unified frontend (bat-sh-go, merged into the
  // busybox): a real batch lexer/parser → A1 shIR → JS.
  const { getOtranspilerl } = await import("./otranspilerl.js");
  const lib = await getOtranspilerl();
  let a1;
  if (lang === "sh" || lang === "zsh") {
    // Seed the shell's known variables so $x reads compile live — the
    // same seeding runViaTranspiler does for REPL lines.
    const seed = [...otVars].map(([k, v]) =>
      Array.isArray(v)
        ? `${k}=(${v.map((x) => JSON.stringify(String(x))).join(" ")});`
        : `${k}=${JSON.stringify(String(v))};`
    ).join("");
    a1 = JSON.parse(lib.shir(seed + content));
  } else {
    const { ensureBusyboxWasm, busyboxA1 } = await import("./busybox.js");
    const fetchBytes = async () => {
      if (typeof process !== "undefined" && process.versions && process.versions.node) {
        const { readFile } = await import("node:fs/promises");
        return new Uint8Array(await readFile(new URL("../www/wasm-bin/otranspiler-busybox.wasm", import.meta.url)));
      }
      const { BUSYBOX_VERSION } = await import("./busybox.js");
      const resp = await fetch("wasm-bin/otranspiler-busybox.wasm?v=" + BUSYBOX_VERSION);
      if (!resp.ok) throw new Error("busybox fetch " + resp.status);
      return new Uint8Array(await resp.arrayBuffer());
    };
    const wasmPath = await ensureBusyboxWasm(fs, { goRunner, goCmd, fetchBytes });
    a1 = await busyboxA1(content, lang, { fs, wasmPath, goRunner });
  // the otranspilerl renderer panics on Goto/Label ("unreachable") —
  // refuse loudly up front (REFUSE > GUESS) instead of crashing
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
  return runEstreeProgram(program, lineAssigned, srcArgs);
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
    const fn = new Function("args", "fs", "console", "stdin", "env", "sh2", "sh2lib", "shell", "qbe2wasm", "pipe", `
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
    const ret = await fn(args, fs, fakeConsole, pipeText(stdin), env, sh2rt.sh2, sh2libFacade, shellApi, qbe2wasm, pipe);
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
    process.stderr.write(`${cmd}: error: ${e.message}\n`);
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
