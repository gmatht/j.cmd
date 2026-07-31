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
import { getManPage, manIndex, searchManPages, MAN_PAGES } from "./manpages.js";

const wasmRunner = new WasmRunner(fs);
const sh2libFacade = buildSh2LibFacade(fs);  // debashl toolchain, injected into .js commands
const wasmerReg = new WasmerRegistry(fs);

// Pipe input for the current command — the previous pipeline segment's
// captured stdout. Builtins that read stdin (head, ...) consume this.
let stdinBuffer = "";

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
let runId = 0;              // bumped per command — stale aborts don't linger

// Run a command's promise so that Ctrl+C can abort it. Returns the
// command's exit code (130 if interrupted).
async function runInterruptible(promise) {
  const myId = ++runId;
  suppressOutput = false;
  running = true;
  let rejectFn = null;
  interruptSignal = () => { if (rejectFn) rejectFn(new InterruptError()); };
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
        const output = await fs.formatList(dir, { long });
        if (!output) continue;
        if (dirs.length > 1) process.stdout.write(`${dir}:\n`);
        process.stdout.write(output);
        // Note when a remote listing came from the persistent ls cache
        // (24h TTL) — "cached 3h ago" beats a silent, unexplained list.
        const cacheNote = await fs.cacheInfo(dir);
        if (cacheNote && cacheNote.age >= 60000) {
          const tag = cacheNote.stale
            ? `cached ${formatAge(cacheNote.age)} — API unavailable, stale`
            : `cached ${formatAge(cacheNote.age)}`;
          process.stdout.write(`  (${tag})\n`);
        } else {
          // Fresh request — report the API's rolling-hour usage from the
          // response headers (exact for the IP, not an estimate).
          const rate = await fs.rateInfo(dir);
          if (rate && rate.limit > 0) {
            const used = Math.max(0, rate.limit - rate.remaining);
            process.stdout.write(`  (${rate.name}: ${used}/${rate.limit} API requests used ${rate.period})\n`);
          }
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
      // No files — read from stdin (pipe input)
      process.stdout.write(stdinBuffer);
      if (stdinBuffer && !stdinBuffer.endsWith("\n")) process.stdout.write("\n");
      return 0;
    }
    let hadError = false;
    for (const file of args) {
      try {
        const content = await fs.read(file);
        process.stdout.write(content);
        if (!content.endsWith("\n")) process.stdout.write("\n");
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
    process.stdout.write(fs.cwd + "\n");
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
    const spec = args[0];
    const target = args[1];
    if (!target) {
      process.stderr.write(`mount: usage: mount github:user/repo /mymount\n`);
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
  grep [opts] <pattern> [file...]  Search files/stdin for pattern
                 (-i ignore case · -n line numbers · -v invert · -c count
                  -l files with matches · -r recursive · -e PATTERN)
  find [path...] [expr]  Find files by name/type
                 (-name PAT · -iname PAT · -type f|d · -maxdepth N · -mindepth N)
  mount [github:user/repo /path]  List mounts, or attach a GitHub repo at a path
  unmount <path>   Detach a user-created mount
  wasmer          WASM package manager (list / install <pkg> / search <term>)
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
      return { type: "wasm", path: resolved };
    }
    if (/\.(js|mjs)$/i.test(resolved)) {
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
        return { type: "wasm", path: dir + "/" + name + ".wasm" };
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
          return { type: "file", path: dir + "/" + clean };
        }
        if (clean === name + ".mjs") {
          return { type: "file", path: dir + "/" + clean };
        }
        if (clean === name + ".wasm") {
          return { type: "wasm", path: dir + "/" + clean };
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
  // use (cc is an alias for the compiler binary)
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

  // Handle redirection: > file
  let outputRedirect = null;
  const redirectIndex = args.indexOf(">");
  if (redirectIndex !== -1) {
    outputRedirect = args[redirectIndex + 1];
    args.splice(redirectIndex, 2);
  }

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

  // Make pipe input available to builtins (head etc.)
  stdinBuffer = stdin;

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
      const wasmOut = wasmRunner.getStdout();
      const wasmErr = wasmRunner.getStderr();
      if (outputRedirect) {
        await fs.write(outputRedirect, wasmOut);
      } else if (isLast) {
        if (wasmOut) process.stdout.write(wasmOut);
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
      if (capture) {
        process.stdout.write = (chunk) => {
          chunks.push(chunk);
          return true;
        };
      }
      let code = 0;
      try {
        code = (await resolved.fn(args)) ?? 0;
      } finally {
        if (capture) {
          process.stdout.write = origWrite;
          const captured = chunks.join("");
          if (outputRedirect) await fs.write(outputRedirect, captured);
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
    const fn = new Function("args", "fs", "console", "stdin", "env", "sh2", "sh2lib", `
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
    const ret = await fn(args, fs, fakeConsole, stdin, env, sh2rt.sh2, sh2libFacade);
    // A command file may return a number to set its exit status
    const code = typeof ret === "number" ? ret : 0;
    output = logChunks.join("");
    if (outputRedirect) {
      await fs.write(outputRedirect, output);
      output = "";
    } else if (isLast) {
      process.stdout.write(output);
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
// first part. A lone `&` is a syntax error (no background jobs here).
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
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    capturedErr += chunk;
    return true;
  };
  let code = 0;
  try {
    code = (await handleLine(cmdLine, stdin)) ?? 0;
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
  return { out: captured, err: capturedErr, code };
}

async function handleLine(line, initialStdin) {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Split on && / || and run left to right. `&&` runs the next command
  // only if the previous one succeeded (exit 0); `||` runs it only if
  // the previous one failed. Each conditional part is itself a pipeline.
  let parts;
  try {
    parts = splitConditionals(trimmed);
  } catch (e) {
    process.stderr.write(`tinysh: ${e.message}\n`);
    return;
  }
  // An empty segment means the line started with an operator, ended
  // with one, or had two operators in a row (`&& echo hi`, `echo hi &&`,
  // `a && || b`) — all syntax errors.
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].text.trim()) {
      const nextOp = i + 1 < parts.length ? parts[i + 1].op : null;
      const token = nextOp ? `'${nextOp}'` : "newline";
      process.stderr.write(`tinysh: syntax error near unexpected token ${token}\n`);
      return;
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

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `tinysh:${fs.cwd}$ `,
  terminal: process.stdin.isTTY,
  completer: tabComplete,
});

if (process.stdin.isTTY) {
  // Read the user's ~/.tinyshrc before the first prompt so exports
  // and setup commands are already in effect (like bash and .bashrc).
  await loadConfig();
  rl.on("line", async (line) => {
    await runInterruptible(handleLine(line));
    rl.setPrompt(`tinysh:${fs.cwd}$ `);
    rl.prompt();
  });

  // Ctrl+C: registering a SIGINT listener takes over from readline's
  // default (which would close the shell). While a command runs we
  // abort it (exit 130); at the prompt we cancel the current line.
  rl.on("SIGINT", () => {
    process.stdout.write("^C\n");
    if (running) {
      if (interruptSignal) interruptSignal();
      return;
    }
    // Cancel the partially typed line and redraw the prompt.
    rl.write(null, { ctrl: true, name: "u" });
    rl.setPrompt(`tinysh:${fs.cwd}$ `);
    rl.prompt();
  });

  rl.on("close", () => {
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
