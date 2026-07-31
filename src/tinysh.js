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

const wasmRunner = new WasmRunner(fs);

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
        return;
      } else {
        dirs.push(a);
      }
    }
    if (dirs.length === 0) dirs.push(".");
    for (const dir of dirs) {
      try {
        const output = await fs.formatList(dir, { long });
        if (!output) continue;
        if (dirs.length > 1) process.stdout.write(`${dir}:\n`);
        process.stdout.write(output);
      } catch (e) {
        process.stderr.write(`ls: ${dir}: ${e.message}\n`);
      }
    }
  },

  async cat(args) {
    if (args.length === 0) {
      // No files — read from stdin (pipe input)
      process.stdout.write(stdinBuffer);
      if (stdinBuffer && !stdinBuffer.endsWith("\n")) process.stdout.write("\n");
      return;
    }
    for (const file of args) {
      try {
        const content = await fs.read(file);
        process.stdout.write(content);
        if (!content.endsWith("\n")) process.stdout.write("\n");
      } catch (e) {
        process.stderr.write(`cat: ${file}: ${e.message}\n`);
      }
    }
  },

  async echo(args) {
    process.stdout.write(args.join(" ") + "\n");
  },

  async pwd(args) {
    process.stdout.write(fs.cwd + "\n");
  },

  async cd(args) {
    const dir = args[0] || "/home";
    try {
      await fs.list(dir);
      const r = fs._resolve(dir);
      fs.cwd = r;
    } catch (e) {
      process.stderr.write(`cd: ${dir}: ${e.message}\n`);
    }
  },

  async rm(args) {
    if (args.length === 0) {
      process.stderr.write("rm: missing operand\n");
      return;
    }
    for (const file of args) {
      try {
        await fs.remove(file);
      } catch (e) {
        process.stderr.write(`rm: ${file}: ${e.message}\n`);
      }
    }
  },

  async mkdir(args) {
    if (args.length === 0) {
      process.stderr.write("mkdir: missing operand\n");
      return;
    }
    for (const dir of args) {
      try {
        const r = fs._resolve(dir);
        await fs.write(r + "/.directory", "");
      } catch (e) {
        process.stderr.write(`mkdir: ${dir}: ${e.message}\n`);
      }
    }
  },

  async cp(args) {
    if (args.length < 2) {
      process.stderr.write("cp: missing operand\n");
      return;
    }
    const src = args[0];
    const dest = args[1];
    try {
      const content = await fs.read(src);
      await fs.write(dest, content);
    } catch (e) {
      process.stderr.write(`cp: ${src}: ${e.message}\n`);
    }
  },

  async mv(args) {
    if (args.length < 2) {
      process.stderr.write("mv: missing operand\n");
      return;
    }
    const src = args[0];
    const dest = args[1];
    try {
      const content = await fs.read(src);
      await fs.write(dest, content);
      await fs.remove(src);
    } catch (e) {
      process.stderr.write(`mv: ${src}: ${e.message}\n`);
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
          return;
        }
        i++;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10);
      } else if (a.startsWith("-")) {
        process.stderr.write(`head: invalid option -- '${a}'\n`);
        return;
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
      return;
    }
    for (const file of files) {
      try {
        const content = await fs.read(file);
        if (files.length > 1) process.stdout.write(`==> ${file} <==\n`);
        printLines(content);
      } catch (e) {
        process.stderr.write(`head: ${file}: ${e.message}\n`);
      }
    }
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
          return;
        }
        pattern = args[++i];
        patterns.push(pattern);
        patternExplicit = true;
      } else if (!optsDone && a.startsWith("--")) {
        process.stderr.write(`grep: unrecognized option '${a}'\n`);
        return;
      } else if (!optsDone && a.startsWith("-") && a.length > 1) {
        // Bundled short flags, e.g. -in or -cv
        let ok = true;
        for (const ch of a.slice(1)) {
          if (shortFlags[ch]) shortFlags[ch]();
          else { ok = false; break; }
        }
        if (!ok) {
          process.stderr.write(`grep: invalid option -- '${a}'\n`);
          return;
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
      return;
    }
    // Multiple -e patterns match if ANY of them matches (OR)
    const patternSource = patterns.map(p => `(?:${p})`).join("|");

    let re;
    try {
      re = new RegExp(patternSource, ignoreCase ? "i" : "");
    } catch (e) {
      process.stderr.write(`grep: invalid regular expression: '${patterns.join("', '")}'\n`);
      return;
    }

    // Remote mounts would require crawling the network; refuse that and
    // only grep them when a specific file is named.
    const REMOTE = ["/http/", "/github/", "/mount/github/", "/gitlab/", "/mount/gitlab/"];
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
    };

    if (files.length === 0) {
      processContent(stdinBuffer, "(standard input)");
      return;
    }

    // Recursively collect files under a directory
    const walk = async (dir) => {
      if (isRemote(dir)) {
        process.stderr.write(`grep: skipping remote mount ${dir} (name specific files to search them)\n`);
        return;
      }
      let entries;
      try { entries = await fs.list(dir); } catch (e) {
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
            processContent(content, full);
          } catch (e) {
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
        process.stderr.write(`grep: skipping remote mount ${r} (name specific files to search them)\n`);
        continue;
      }
      try {
        const st = await fs.stat(file);
        if (st.type === "dir") {
          if (recursive) await walk(r);
          else process.stderr.write(`grep: ${file}: Is a directory\n`);
          continue;
        }
        const content = await fs.read(file);
        processContent(content, r);
      } catch (e) {
        process.stderr.write(`grep: ${file}: ${e.message}\n`);
      }
    }
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
    const REMOTE = ["/http/", "/github/", "/mount/github/", "/gitlab/", "/mount/gitlab/"];
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
        if (!skippedRemote) {
          process.stderr.write(`find: skipping remote mount ${dir} (name specific files to search them)\n`);
          skippedRemote = true;
        }
        return;
      }
      let entries;
      try { entries = await fs.list(dir); } catch (e) {
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

    const seen = new Set();
    for (const path of paths) {
      const r = fs._resolve(path);
      if (seen.has(r)) continue;
      seen.add(r);
      let st;
      try { st = await fs.stat(r); } catch (e) {
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
        process.stderr.write(`find: skipping remote mount ${r} (name specific files to search them)\n`);
        continue;
      }
      if (0 < maxDepth) await walk(r, 0);
    }
  },

  async help(args) {
    process.stdout.write(`tinysh — minimal shell for the virtual filesystem

Built-in commands:
  ls [dir]        List directory contents (ls -l: long format)
  cat <file>...   Print file contents
  echo <text>     Print text
  pwd             Print working directory
  cd [dir]        Change directory
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
  help            This help
  exit            Exit the shell

Pipes: cmd1 | cmd2 — cmd1's stdout becomes cmd2's stdin
  Example: cat README.md | head -3
  Example: echo "hello" | grep -i hello
  Example: find /home -name *.txt | head -5

Aliases: vi/vim/nano = edit · less/more = cat · cls = clear
         dir = ls · ? = help · q/quit = exit
         apt/yum/brew/pip = wasmer (WASM packages)

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
  if (builtins[name]) return { type: "builtin", fn: builtins[name] };

  const searchPaths = ["/commands", "/usr/bin", "/bin"];
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
    return { ok: false, output: "" };
  }
  if (tokens.length === 0) return { ok: false, output: "" };
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
    return { ok: false, output: "" };
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
      if (wasmRunner.getExitCode() !== 0) {
        process.stderr.write(`${cmd}: exited with code ${wasmRunner.getExitCode()}\n`);
        return { ok: false, output: "" };
      }
      return { ok: true, output };
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
      await resolved.fn(args);
      if (capture) {
        process.stdout.write = origWrite;
        const captured = chunks.join("");
        if (outputRedirect) await fs.write(outputRedirect, captured);
        else output = captured;
      }
      return { ok: true, output };
    }

    // Run a .js command file from the virtual filesystem
    const content = await fs.read(resolved.path);
    // Wrap in async IIFE to support top-level await; stdin is the 4th arg
    const fn = new Function("args", "fs", "console", "stdin", `
        return (async () => {
          ${content}
        })();
      `);
    const logChunks = [];
    const fakeConsole = { log: (...msgs) => logChunks.push(msgs.join(" ") + "\n") };
    await fn(args, fs, fakeConsole, stdin);
    output = logChunks.join("");
    if (outputRedirect) {
      await fs.write(outputRedirect, output);
      output = "";
    } else if (isLast) {
      process.stdout.write(output);
      output = "";
    }
    return { ok: true, output };
  } catch (e) {
    process.stderr.write(`${cmd}: error: ${e.message}\n`);
    return { ok: false, output: "" };
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Split on pipes and run left to right, feeding each command's stdout
  // to the next command's stdin.
  const segments = splitPipe(trimmed);
  let stdin = "";
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].trim()) {
      process.stderr.write(`tinysh: syntax error near unexpected token '|'\n`);
      return;
    }
    const result = await runSegment(segments[i], stdin, i === segments.length - 1);
    if (!result.ok) return;
    stdin = result.output;
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
