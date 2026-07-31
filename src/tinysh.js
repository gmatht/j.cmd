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
  help            This help
  exit            Exit the shell

Pipes: cmd1 | cmd2 — cmd1's stdout becomes cmd2's stdin
  Example: cat README.md | head -3
  Example: echo "hello" | grep -i hello

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

// Split a line into pipeline segments on `|`, respecting quotes
// (quoted args land in one segment even though tokenizing is naive).
function splitPipe(line) {
  const segments = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of line) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "|" && !inSingle && !inDouble) {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segments.push(cur);
  return segments;
}

// Execute one pipeline segment. `stdin` carries the previous segment's
// stdout. Returns { ok, output } — `output` is the captured stdout that
// should be fed to the next segment (empty for the last segment).
async function runSegment(segmentText, stdin, isLast) {
  const tokens = segmentText.trim().split(/\s+/);
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
