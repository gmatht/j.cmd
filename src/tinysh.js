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
import { WasmRunner } from "./wasm.js";
import { WasmerRegistry } from "./wasmer.js";
import { env, expandRef } from "./env.js";

const wasmRunner = new WasmRunner(fs);
const wasmerReg = new WasmerRegistry(fs);

// Pipe input for the current command — the previous pipeline segment's
// captured stdout. Builtins that read stdin (head, ...) consume this.
let stdinBuffer = "";

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

  async wasmer(args) {
    // wasmer list | install <pkg> | search <term> — WASM package
    // manager. The browser fetches the same prebuilt binaries over
    // HTTP; the CLI reads them from the repo's www/wasm-bin/ dir.
    if (!args[0] || args[0] === "help") {
      process.stdout.write(`wasmer — WASM package manager for browser shell

wasmer list                    — list available packages
wasmer search <term>           — search packages
wasmer install <name>          — copy package to /bin/
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
      const destPath = `/bin/${name}.wasm`;
      await fs.writeBlob(destPath, new Blob([buf]));
      process.stdout.write(`Installed ${name} → ${destPath} (${buf.length} bytes)\n`);
      return 0;
    }
    process.stderr.write(`wasmer: unknown command '${args[0]}' (list, install, search, help)\n`);
    return 2;
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
  wasmer          WASM package manager (list / install <pkg> / search <term>)
  true            Always succeeds (exit 0)
  false           Always fails (exit 1)
  help            This help
  exit            Exit the shell

Pipes: cmd1 | cmd2 — cmd1's stdout becomes cmd2's stdin
  Example: cat README.md | head -3
  Example: echo "hello" | grep -i hello
  Example: find /home -name *.txt | head -5

Conditionals: cmd1 && cmd2 — run cmd2 only if cmd1 succeeded (exit 0)
              cmd1 || cmd2 — run cmd2 only if cmd1 failed (non-zero exit)
  Example: grep TODO README.md || echo "no TODOs"
  Example: cat x.js && echo ok || echo failed
  (A command's exit status: 0 success · 1 failure · 2 usage error · 127 not found)

Aliases: vi/vim/nano = edit · less/more = cat · cls = clear
         dir = ls · ? = help · q/quit = exit
         apt/yum/brew/pip = wasmer (WASM packages)

Environment variables:
  $PATH  /commands:/usr/bin:/bin   command search path
  $HOME  /home                     default directory (bare cd goes there)
  $USER  tinysh                    current user
  $PWD   current directory
  Expand with $NAME or \${NAME}: echo $HOME · cd $HOME · cat $HOME/examples/note.txt
  (single quotes or a \$ keep the $ literal: echo '$HOME' prints $HOME)

Any other command runs a .js file from the command path.
Write new commands by creating .js files in /commands/.
`);
  },

  async exit(args) {
    process.exit(0);
  }
};

// ─── Command Resolution ─────────────────────────────────────────

async function resolveCommand(name) {
  // A wasm32-wasi binary in the command path is a "native command" and
  // shadows the builtin of the same name — so `wasmer install grep`
  // (which drops /bin/grep.wasm) makes `grep` run real grep compiled
  // to WASM instead of the JS fallback.
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
  // Auto-load a wasm binary from the local server's wasm-bin/ on first
  // use (cc is an alias for the compiler binary)
  let wasmName = name;
  if (name === "cc") wasmName = "compiler";
  try {
    const resp = await fetch("wasm-bin/" + wasmName + ".wasm");
    if (resp.ok) {
      const blob = await resp.blob();
      const destPath = "/bin/" + name + ".wasm";
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
      "wasmer": "wasmer coming soon — WASM package manager for browser shell",
    };
    const hint = hints[cmd];
    if (hint) {
      process.stderr.write(`${cmd}: command not found — try "${hint}" instead\n`);
    } else {
      process.stderr.write(`${cmd}: command not found\n`);
    }
    return { ok: false, code: 127, output: "" };
  }

  // Make pipe input available to builtins (head etc.)
  stdinBuffer = stdin;

  try {
    if (resolved.type === "wasm") {
      // Run a wasm32-wasi binary (full WASI via @wasmer/wasi, filesystem
      // bridged to our VirtualFS via @wasmer/wasmfs)
      await wasmRunner.run(resolved.path, [cmd, ...args], stdin);
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
        return { ok: false, code: exitCode, output: "" };
      }
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
      return { ok: code === 0, code, output };
    }

    // Run a .js command file from the virtual filesystem
    const content = await fs.read(resolved.path);
    // Wrap in async IIFE to support top-level await; stdin is the 4th arg
    const fn = new Function("args", "fs", "console", "stdin", "env", `
        return (async () => {
          ${content}
        })();
      `);
    const logChunks = [];
    const fakeConsole = { log: (...msgs) => logChunks.push(msgs.join(" ") + "\n") };
    const ret = await fn(args, fs, fakeConsole, stdin, env);
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
    return { ok: code === 0, code, output };
  } catch (e) {
    process.stderr.write(`${cmd}: error: ${e.message}\n`);
    return { ok: false, code: 1, output: "" };
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
async function runPipeline(pipelineText) {
  const segments = splitPipe(pipelineText);
  let stdin = "";
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

async function handleLine(line) {
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
    exitCode = await runPipeline(parts[i].text);
  }
}

// ─── Main ───────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `tinysh:${fs.cwd}$ `,
  terminal: process.stdin.isTTY,
});

if (process.stdin.isTTY) {
  rl.on("line", async (line) => {
    await handleLine(line);
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
