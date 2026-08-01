// ─── tinysh: Minimal shell that runs .js files as commands ──────
//
// tinysh is to the virtual filesystem what /bin/sh is to a Unix kernel.
// It reads lines, splits on spaces, and executes .js files.
//
// JavaScript is the "machine code" of this architecture.
// tinysh is the "CPU" that runs it — minimal, dumb, reliable.
//
// Usage:
//   node src/tinysh.js           # interactive REPL
//   node src/tinysh.js < file    # batch mode from stdin
// -----------------------------------------------------------------

import { createInterface } from "readline";
import { fs } from "./fs/index.js";
import { formatAge } from "./fs/lscache.js";
import { WasmRunner } from "./wasm.js";
import { WasmerRegistry } from "./wasmer.js";
import { env, expandRef } from "./env.js";
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

  async pwd(args) {
    process.stdout.write((fs.view ? fs.view(fs.cwd) : fs.cwd) + "\n");
    return 0;
  },

  async true(args) {
    // Always succeeds (exit 0) — handy with `&&`
    return 0;
  },

  async false(args) {
    // Always fails (exit 1) — handy with `||`
    return 1;
  },

  async cd(args) {
    const dir = args[0] || env.HOME;
    try {
      await fs.list(dir);
      const r = fs._resolve(dir);
      fs.cwd = r;
      env.PWD = r;
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
      if (arg === "-p") continue; // harmless to accept alongside assignments
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        hadError = true;
        process.stderr.write(`export: '${arg}': not a valid identifier\n`);
        continue;
      }
      env[name] = eq === -1 ? "" : arg.slice(eq + 1);
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
        await fs.stat(file); // fail on nonexistent paths, like real rm
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
    const dest = args[1];
    try {
      const content = await fs.read(src);
      await fs.write(dest, content);
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
    const dest = args[1];
    try {
      const content = await fs.read(src);
      await fs.write(dest, content);
      await fs.remove(src);
      return 0;
    } catch (e) {
      process.stderr.write(`mv: ${src}: ${e.message}\n`);
      return 1;
    }
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
    // grep [-i] [-n] [-v] [-c] [-l] [-r] [-e PATTERN] [--] PATTERN [FILE...]
    // With no FILE arguments, searches stdin (pipe input).
    let ignoreCase = false, lineNumber = false, invert = false;
    let count = false, filesWithMatches = false, recursive = false;
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

  async find(args) {
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
www/wasm-bin/ (see build-wasm-compiler.sh, build-wasm-grep.sh).
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
    //   bash → Perl (sh2perl.wasm, the debashc compiler) → JS (perl2js)
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`bash2js — transpile bash to JavaScript (runs entirely in the browser)

Usage:
  bash2js 'echo hello world'   transpile an inline bash script
  bash2js -f script.sh         transpile a file from the virtual FS
  cat script.sh | bash2js      transpile from a pipe

Pipeline:  bash → ESTree (debashl.wasm) → JS (sh2.* runtime);
         falls back to sh2perl → perl2js if debashl is unavailable
The generated JS targets the rt runtime + env; save it to a .js file
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
      const { js } = await bashToJS(fs, source, { wasmRunner });
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
    //   bash → ESTree (debashl.wasm) → JS (sh2.* runtime) — with a
//   fallback to the Perl path (sh2perl.wasm → perl2js) → run in the shell
    if (args[0] === "-h" || args[0] === "--help") {
      process.stdout.write(`bash — run bash commands by transpiling them to JS

Usage:
  bash 'echo hello world'  transpile + execute inline bash
  bash -c 'echo hi'        same as inline
  bash script.sh           execute a bash script file from the virtual FS
  cat script.sh | bash     execute from a pipe
  bash -                   execute from a pipe (explicit)
    bash                     interactive REPL (state persists per line)

Pipeline:  bash → ESTree (debashl.wasm) → JS (sh2.* runtime);
         falls back to sh2perl → perl2js if debashl is unavailable → executed
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
      return await runBash(fs, source, {
        wasmRunner,
        stdout: process.stdout,
        stderr: process.stderr,
        runCmd: runNestedCommand,
        args: scriptArgs,
        argv0: args[0] && !args[0].startsWith("-") ? args[0] : "bash",
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
    process.stdout.write(`tinysh — minimal shell for the virtual filesystem

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
  bash2js         Transpile bash to JavaScript (sh2perl → perl2js)
  bash            Run bash commands: transpile to JS and execute
                  (bash 'echo hi' · bash script.sh · cat s.sh | bash)
  true            Always succeeds (exit 0)
  false           Always fails (exit 1)
  which <cmd>...  Show the path (or builtin) the shell would run
                  (wasm binary → builtin → .js/.mjs/.wasm files in $PATH)
  man [cmd]       Manual page for a command (man alone: index;
                  man -k <word>: search pages, like apropos)
  help            This help
  exit            Exit the shell

Startup config (~/.tinyshrc):
  $HOME/.tinyshrc is read at startup (interactive mode); each line
  runs as a shell command, '#' starts a comment.
    export EDITOR=edit
    echo "Welcome back"
  (in the browser, edit it with: edit ~/.tinyshrc)

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
  $USER  tinysh                    current user
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
    // chmod OCTAL file... — only the owner (or tinysh/root) may change a
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
    const user = env.USER || "tinysh";
    let hadError = false;
    for (const file of args.slice(1)) {
      const a = fs.attrOf(file);
      if (!a) {
        process.stderr.write(`chmod: ${file}: No such file or directory\n`);
        hadError = true;
        continue;
      }
      if (user !== "tinysh" && user !== "root" && user !== a.owner) {
        process.stderr.write(`chmod: ${file}: operation not permitted (owned by ${a.owner})\n`);
        hadError = true;
        continue;
      }
      fs.setAttr(file, { owner: a.owner, mode });
    }
    return hadError ? 1 : 0;
  },

  async whoami(args) {
    process.stdout.write((env.USER || "tinysh") + "\n");
    return 0;
  },

  async su(args) {
    // su                  → drop to nobody (unprivileged)
    // su <name>           → switch to that user (su tinysh / su root → back)
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
    const home = target === "tinysh" ? "/home" : "/home/" + target;
    env.HOME = home;
    try {
      await fs.stat(home);
    } catch {
      try {
        await fs.write(home + "/README.txt",
          `Welcome, ${target}!\n` +
          `This is your home directory (${home}).\n` +
          `You are ${target === "nobody" ? "an unprivileged user" : "running as " + target} on tinysh.\n` +
          `Run 'su tinysh' to return to the admin account.\n`);
      } catch {}
    }
    // The new home is owned by the target user (su runs as admin, so
    // the writes above would otherwise attribute it to tinysh — leaving
    // the account unable to write in its own home).
    fs.setAttr(home, { owner: target, mode: 0o700 });
    try { fs.setAttr(home + "/README.txt", { owner: target, mode: 0o644 }); } catch {}
    if (target === "tinysh" && suState.prev) {
      fs.cwd = suState.prev.cwd;
      suState.prev = null;
    } else {
      fs.cwd = home;
    }
    env.PWD = fs.cwd;
    const unpriv = ["nobody", "daemon", "guest", "www-data"].includes(target);
    process.stdout.write(`su: switched to ${target} — ${unpriv ? "unprivileged" : "user"}\n`);
    process.stdout.write(`    HOME=${env.HOME} · run 'su tinysh' to return\n`);
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
  }
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
// admin-trusted code: builtins and .js/.wasm files owned by tinysh.
// Custom code (anything they — or another non-admin — created) is
// refused, so an unprivileged session can't escalate by dropping a
// .js/.wasm file and running it.
function isPrivilegedUser() {
  const u = env.USER || "tinysh";
  return u === "tinysh" || u === "root";
}
function customExecDenied(path) {
  if (isPrivilegedUser()) return null;
  const a = fs.attrOf(path);
  const owner = a ? a.owner : "tinysh";
  if (owner === "tinysh") return null;
  return {
    type: "badpath",
    path,
    err: "operation not permitted: unprivileged users cannot run custom code (owned by " + owner + ")",
  };
}

async function findCommand(name) {
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
    if (/\.(js|mjs)$/i.test(resolved)) {
      const denied = customExecDenied(resolved);
      if (denied) return denied;
      return { type: "file", path: resolved };
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
      // $NAME / ${NAME} expansion outside quotes
      const ref = expandRef(segment, i);
      cur += ref.value;
      i = ref.end - 1;
      started = true;
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
async function runSegment(segmentText, stdin, isLast) {
  let tokens;
  try {
    tokens = tokenize(segmentText);
  } catch (e) {
    process.stderr.write(`tinysh: ${e.message}\n`);
    return { ok: false, code: 2, output: "" };
  }
  if (tokens.length === 0) return { ok: false, code: 2, output: "" };
  const cmd = tokens[0];
  const args = tokens.slice(1);

  let outputRedirect = null;
  let appendRedirect = false;
  let redirectIndex = args.indexOf(">>");
  if (redirectIndex === -1) redirectIndex = args.indexOf(">");
  else appendRedirect = true;
  if (redirectIndex !== -1) {
    outputRedirect = args[redirectIndex + 1];
    args.splice(redirectIndex, 2);
  }

  // python — MicroPython engine (reactor, src/py.js): REPL, -c, script
  // files and stdin. Intercepted before resolveCommand so it never
  // auto-loads python.wasm.
  if (cmd === "python" && !cmd.includes("/")) {
    return await runPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect);
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
  const guardedOut = (chunk) => (suppressOutput ? true : realOut.call(process.stdout, chunk));
  const guardedErr = (chunk) => (suppressOutput ? true : realErr.call(process.stderr, chunk));
  process.stdout.write = guardedOut;
  process.stderr.write = guardedErr;

  try {
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
      // cc/compiler reads its C source via WASI at the VFS root — resolve
      // relative paths ("t.c") against the shell cwd first (/home/t.c)
      if ((cmd === "cc" || cmd === "compiler") && args.length > 0) {
        const resolve = (p) => (p && p.startsWith("/") ? p : fs._resolve(p));
        if (args[0] === "-o" && args[1]) {
          wasmArgs = [cmd, resolve(args[2])];
        } else if (args[0] === "-S") {
          wasmArgs = [cmd, resolve(args[1])];
        } else {
          wasmArgs = [cmd, resolve(args[0])];
        }
      }
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
      process.stderr.write(`tinysh: syntax error near unexpected token '|'\n`);
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
    if (process.stdout.write === capOut) {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }
    return origWrite.call(process.stdout, chunk);
  };
  const capErr = (chunk) => {
    if (process.stderr.write === capErr) {
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
  // runNestedCommand; cron jobs persist to /home/.tinyshcron.
  if (!globalThis.__tinyshJobs) {
    globalThis.__tinyshJobs = createJobScheduler({
      fs,
      runLine: (cmd) => runNestedCommand(cmd),
      stdout: process.stdout,
      stderr: process.stderr,
      storagePath: "/home/.tinyshcron",
    });
  }
  return globalThis.__tinyshJobs;
}

// Background jobs (`cmd &`): one shared table per shell. Output goes
// straight to the terminal (live); the completion notice is printed by
// onUpdate. See createBgJobs in src/jobs.js.
function getBgJobs() {
  if (!globalThis.__tinyshBgJobs) {
    globalThis.__tinyshBgJobs = createBgJobs({
      runLine: async (job) => (await runPipeline(job.cmd)) ?? 0,
      onUpdate: (job) => {
        if (job.running || job.notified) return;
        job.notified = true;
        const status = job.killed ? "Killed" : job.code === 0 ? "Done" : `Failed (exit ${job.code})`;
        process.stdout.write(`[${job.id}]+  ${status.padEnd(18)} ${job.cmd}\n`);
      },
    });
  }
  return globalThis.__tinyshBgJobs;
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
    process.stderr.write(`tinysh: ${e.message}\n`);
    return;
  }
  for (const seg of segments) {
    if (!seg.text.trim()) {
      process.stderr.write(`tinysh: syntax error near unexpected token '&'\n`);
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
        process.stderr.write(`tinysh: ${e.message}\n`);
        return;
      }
      const bad = cond.find((p) => !p.text.trim());
      if (bad) {
        const token = bad.op || "newline";
        process.stderr.write(`tinysh: syntax error near unexpected token '${token}'\n`);
        return;
      }
    }
  }

  let exitCode = 0;
  for (const seg of segments) {
    if (seg.bg) {
      const job = getBgJobs().launch(seg.text);
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
    process.stderr.write(`tinysh: ${e.message}\n`);
    return 2;
  }
  // An empty segment means the segment started with an operator, ended
  // with one, or had two operators in a row (`&& echo hi`, `echo hi &&`,
  // `a && || b`) — all syntax errors.
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].text.trim()) {
      const nextOp = i + 1 < parts.length ? parts[i + 1].op : null;
      const token = nextOp ? `'${nextOp}'` : "newline";
      process.stderr.write(`tinysh: syntax error near unexpected token ${token}\n`);
      return 2;
    }
  }

  let exitCode = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      if (parts[i].op === "&&" && exitCode !== 0) continue;
      if (parts[i].op === "||" && exitCode === 0) continue;
    }
    exitCode = await runPipeline(parts[i].text, initialStdin);
  }
  return exitCode;
}

// ─── Startup config (~/.tinyshrc) ─────────────────────────────
// Like a Unix shell's rc file (.bashrc / .zshrc), $HOME/.tinyshrc
// is read at startup and each non-comment line is run as a shell
// command. Use it for persistent environment variables and setup:
//
//   # sample ~/.tinyshrc  (i.e. /home/.tinyshrc)
//   export EDITOR=edit
//   echo "Welcome back!"
//
// Lines starting with # are comments; a missing file is not an
// error (bash skips a nonexistent .bashrc the same way).
async function loadConfig() {
  const configPath = (env.HOME.replace(/\/+$/, "") || "/") + "/.tinyshrc";
  let content;
  try {
    content = await fs.read(configPath);
  } catch {
    return; // no config file — not an error
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    await handleLine(trimmed);
  }
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
  bashSession: [], bashOut: "", bashMarker: "" };
let shellHistory = [];  // the shell's readline history while a REPL owns it
const suState = { prev: null };  // previous user context, for `su tinysh`

// Prompt shows the current user — su'd users appear as nobody:/home/nobody$
function shellPrompt() {
  const user = env.USER && env.USER !== "tinysh" ? env.USER : "tinysh";
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
  process.stdout.write("bash REPL — state persists per line · exit or Ctrl-D to leave\n");
  rl.setPrompt("bash> ");
  rl.prompt();
  replState.bashSession = [];
  replState.bashMarker = "__bash_repl_" + Date.now() + "_" +
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
  const label = mode === "perl" ? "Perl" : mode === "bash" ? "Bash" : "Python";
  process.stdout.write(`\nLeaving ${label} REPL.\n`);
  rl.history = shellHistory;  // give the shell its history back
  rl.setPrompt(shellPrompt());
  rl.prompt();
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
      });
      const pi = replState.bashOut.indexOf(pre);
      const pj = replState.bashOut.lastIndexOf(post);
      if (pi === -1 || pj === -1 || pj < pi) {
        // POST never printed — the statement was dropped/truncated
        process.stderr.write("bash: syntax error — the line was not run (session unchanged)\n");

      } else {
        const fresh = replState.bashOut.slice(pi + pre.length, pj);
        if (fresh) process.stdout.write(fresh);
        session.push(line);
      }
    } catch (e) {
      process.stderr.write(`bash: ${(e && e.message) ? e.message : String(e)}\n`);
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
    rl.setPrompt(replState.mode === "perl" ? "perl> " : replState.mode === "bash" ? "bash> " : ">>> ");
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
  // Read the user's ~/.tinyshrc before the first prompt so exports
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
      await runInterruptible(handleLine(line));
      rl.setPrompt(shellPrompt());
      rl.prompt();
    }).catch((e) => {
      process.stderr.write(`tinysh: ${e && e.message ? e.message : e}\n`);
    });
  });

  // Ctrl+C: registering a SIGINT listener takes over from readline's
  // default (which would close the shell). While a command runs we
  // abort it (exit 130); at the prompt we cancel the current line.
  rl.on("SIGINT", () => {
    process.stdout.write("^C\n");
    if (replState.active) {
      process.stdout.write("KeyboardInterrupt\n");
      rl.setPrompt(replState.mode === "perl" ? "perl> " : replState.mode === "bash" ? "bash> " : ">>> ");
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
