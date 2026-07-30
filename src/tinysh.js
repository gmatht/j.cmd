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

// ─── Built-in Commands ─────────────────────────────────────────

const builtins = {
  async ls(args) {
    const dir = args[0] || ".";
    try {
      const output = await fs.formatList(dir);
      process.stdout.write(output);
    } catch (e) {
      process.stderr.write(`ls: ${dir}: ${e.message}\n`);
    }
  },

  async cat(args) {
    if (args.length === 0) {
      process.stderr.write("cat: missing operand\n");
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

  async help(args) {
    process.stdout.write(`tinysh — minimal shell for the virtual filesystem

Built-in commands:
  ls [dir]        List directory contents
  cat <file>...   Print file contents
  echo <text>     Print text
  pwd             Print working directory
  cd [dir]        Change directory
  rm <file>...    Remove files
  mkdir <dir>...  Create directories
  cp <src> <dst>  Copy files
  mv <src> <dst>  Move files
  help            This help
  exit            Exit the shell

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
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }
  return null;
}

// ─── Line Handler ───────────────────────────────────────────────

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const tokens = trimmed.split(/\s+/);
  const cmd = tokens[0];
  const args = tokens.slice(1);

  // Handle redirection: > file
  let outputRedirect = null;
  const redirectIndex = args.indexOf(">");
  if (redirectIndex !== -1) {
    outputRedirect = args[redirectIndex + 1];
    args.splice(redirectIndex, 2);
  }

  try {
    const resolved = await resolveCommand(cmd);

    if (!resolved) {
      process.stderr.write(`${cmd}: command not found\n`);
      return;
    }

    if (resolved.type === "builtin") {
      const origWrite = process.stdout.write;
      const chunks = [];
      if (outputRedirect) {
        process.stdout.write = (chunk) => {
          chunks.push(chunk);
          return true;
        };
      }
      await resolved.fn(args);
      if (outputRedirect) {
        process.stdout.write = origWrite;
        const output = chunks.join("");
        await fs.write(outputRedirect, output);
      }
    } else {
      // Run a .js command file from the virtual filesystem
      const content = await fs.read(resolved.path);
      // Wrap in async IIFE to support top-level await
      const fn = new Function("args", "fs", "console", `
        return (async () => {
          ${content}
        })();
      `);
      const logChunks = [];
      const fakeConsole = { log: (...msgs) => logChunks.push(msgs.join(" ") + "\n") };
      await fn(args, fs, fakeConsole);
      const output = logChunks.join("");
      if (outputRedirect) {
        await fs.write(outputRedirect, output);
      } else {
        process.stdout.write(output);
      }
    }
  } catch (e) {
    process.stderr.write(`${cmd}: error: ${e.message}\n`);
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
