// ─── shellcore/builtins.js — the SHARED shell builtins ─────────────
// One implementation of every command both shells expose, parameterized
// by a `ctx` (the shell-specific I/O + machinery; see src/shellcore/index.js).
// The shared singletons (fs, env, manpages, shell state) are imported
// directly — both the CLI (src/jtsh.js) and the browser shell
// (www/index.html) consume the same src/ modules.
import { fs } from "../fs/index.js";
import { env, setPositional, setOption } from "../env.js";
import { getManPage, MAN_PAGES } from "../manpages.js";
import { formatAge } from "../fs/lscache.js";
import { bashToJS, runBash } from "../bash2js.js";
import { batToJS, runBat } from "../bat2js.js";
import { InterruptError } from "./runner.js";

// The interrupt sentinel both shells throw/catch around builtins.


// ── the shared builtins: async NAME(ctx, args) → exit code ─────

// ── the shared builtins: async NAME(ctx, args) → exit code ─────
// Extension → source language (mirrors the frontend testdata exts). A
// non-.sh extensionless file defaults to sh, like bash's source.
export function sourceLangOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? m[1].toLowerCase() : "";
  return { sh: "sh", zsh: "zsh", fish: "fish", c: "c", cc: "cpp", cpp: "cpp", go: "go", py: "py", pl: "pl", perl: "pl", js: "js", bat: "bat", ps1: "powershell", psd1: "powershell", psm1: "powershell", rs: "rust", zig: "zig" }[ext] || "sh";
}

export const builtins = {
  async addr(ctx, args) {
    // addr NAME — print the pointer handle for a variable (array or
    // scalar): `addr a` → `\u0001mem:a:0`. The C frontend's pointer seam
    // (memLoad/memStore/memAdvance) walks shell arrays through these
    // handles — `sum_first "$(addr a)" 3` reads a[0..2] from a sourced
    // C function. A handle is opaque (a pointer is a string, never
    // self-describing); forging one is unsupported.
    const name = String(args[0] ?? "");
    if (!name || /[^A-Za-z0-9_]/.test(name)) {
      ctx.stderr.write("addr: usage: addr NAME (a variable name)\n");
      return 1;
    }
    const h = (ctx.otRt && ctx.otRt.sh2 && ctx.otRt.sh2.memAddrOf)
      ? ctx.otRt.sh2.memAddrOf(name)
      : "\u0001mem:" + name + ":0";
    ctx.stdout.write(h + "\n");
    return 0;
  
  },

  async bash(ctx, args) {
    // bash 'echo hello world' — transpile AND execute bash source
    // bash script.sh          — execute a bash script from the VFS
    // bash -c 'echo hi'       — same as inline (-c accepted for familiarity)
    // cat script.sh | bash    — execute from a pipe
    //
    // Type bash, get generated JS executed:
    //   bash → ESTree (otranspilerl.wasm) → JS (sh2.* runtime) → run in the shell
    if (args[0] === "-h" || args[0] === "--help") {
      ctx.stdout.write(`bash — run bash commands by transpiling them to JS

Usage:
  bash 'echo hello world'  transpile + execute inline bash
  bash -c 'echo hi'        same as inline
  bash script.sh           execute a bash script file from the virtual FS
  cat script.sh | bash     execute from a pipe
  bash -                   execute from a pipe (explicit)
    bash                     interactive REPL (state persists per line)

Pipeline:  bash → ESTree (otranspilerl.wasm) → JS (sh2.* runtime) → executed
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
        ctx.stderr.write("bash: -f needs a file name\n");
        return 2;
      }
      try {
        source = await fs.read(file);
      } catch (e) {
        ctx.stderr.write(`bash: ${file}: ${e.message}\n`);
        return 1;
      }
    } else if (args.length === 0 || args[0] === "-") {
      if (ctx.stdin) {
        source = ctx.stdin; // piped in
      } else if (args.length === 0) {
        // bare `bash` with no pipe → an interactive REPL
        ctx.enterRepl("bash");
        return 0;
      } else {
        ctx.stderr.write("bash: no script given (pass one as an argument, use -f FILE, or pipe it in)\n");
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
        ctx.stderr.write(`bash: ${file}: No such file or directory\n`);
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
      // C functions sourced earlier live in the persistent ctx.otRt (the
      // fresh runBash runtime dispatches to it natively) — give the
      // ctx.otRt this command's pipe input FIRST, so their getline/
      // read_line bridge sees it.
      if (ctx.otRt && ctx.otRt.sh2) { try { ctx.otRt.sh2.stdin = ctx.stdin || ""; } catch {} }
      return await runBash(fs, source, {
        wasmRunner: ctx.wasmRunner,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        runCmd: ctx.runNestedCommand,
        args: scriptArgs,
        argv0: args[0] && !args[0].startsWith("-") ? args[0] : "bash",
        stdin: ctx.stdin || "",
      });
    } catch (e) {
      if (e instanceof InterruptError) throw e;
      ctx.stderr.write(`bash: ${e.message}\n`);
      return 1;
    }
  
  },

  async bash2js(ctx, args) {
    // bash2js 'echo hello'  — transpile bash source to JavaScript
    // bash2js -f file.sh    — transpile a file from the VFS
    // bash2js < script.sh   — transpile from a pipe
    //
    // The whole pipeline runs in the browser:
    //   bash → ESTree (otranspilerl.wasm, the debashc reactor) → JS (sh2.* runtime)
    if (args[0] === "-h" || args[0] === "--help") {
      ctx.stdout.write(`bash2js — transpile bash to JavaScript (runs entirely in the browser)

Usage:
  bash2js 'echo hello world'   transpile an inline bash script
  bash2js -f script.sh         transpile a file from the virtual FS
  cat script.sh | bash2js      transpile from a pipe

Pipeline:  bash → ESTree (otranspilerl.wasm) → JS (sh2.* runtime)
The generated JS targets the sh2.* runtime + env; save it to a .js file
and run it as a command.
`);
      return 0;
    }
    let source = null;
    if (args[0] === "-f" || args[0] === "--file") {
      const file = args[1];
      if (!file) {
        ctx.stderr.write("bash2js: -f needs a file name\n");
        return 2;
      }
      try {
        source = await fs.read(file);
      } catch (e) {
        ctx.stderr.write(`bash2js: ${file}: ${e.message}\n`);
        return 1;
      }
    } else if (args.length === 0 || args[0] === "-") {
      if (ctx.stdin) {
        source = ctx.stdin; // piped in
      } else {
        ctx.stderr.write("bash2js: no script given (pass one as an argument, -f FILE, or pipe it in)\n");
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
      ctx.stdout.write(js);
      return 0;
    } catch (e) {
      ctx.stderr.write(`bash2js: ${e.message}\n`);
      return 1;
    }
  
  },

  async bug(ctx, args) {
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
      else if (a === "--token" && args[i + 1]) { await setBugToken(null, args[++i]); ctx.stdout.write("bug: token saved to ~/.jtsh-gh-token\n"); return 0; }
      else if (a === "--clear-token") { clearBugToken(null); try { const { rmSync } = await import("node:fs"); rmSync(`${(ctx.nodeEnv ? ctx.nodeEnv.HOME : "") || (ctx.nodeCwd ? ctx.nodeCwd() : "/")}/.jtsh-gh-token`, { force: true }); } catch {} ctx.stdout.write("bug: token cleared\n"); return 0; }
      else if (!a.startsWith("-")) rest.push(a);
    }
    const summary = rest.join(" ");
    const snippet = outRing.slice(-lines).join("\n").replace(/^\s+|\s+$/g, "");
    const scope = lines === 20 ? "20" : String(lines);
    const body = buildReport({ summary, expected: expect, snippet, scope, system: await collectSystem(), commit: await collectCommit() });
    if (dryRun) { ctx.stdout.write(body); return 0; }
    const title = "bug: " + ((summary || "").trim().slice(0, 100) || "terminal snippet report");
    const token = webform ? null : await getBugToken(null);
    if (!token) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("jtsh-bug-report.md", body);
      ctx.stdout.write("bug: no GitHub token — report saved to ./jtsh-bug-report.md.\n");
      ctx.stdout.write(`     Set one with: bug --token <PAT>  (or $JTSH_GITHUB_TOKEN)\n`);
      const url = `https://github.com/${BUG_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      ctx.stdout.write(`     …or open the prefilled GitHub form:\n     ${url}\n`);
      return 0;
    }
    try {
      const url = await postIssue({ token, title, body });
      ctx.stdout.write(`bug: filed → ${url}\n`);
    } catch (e) {
      ctx.stderr.write(`bug: ${e.message}\n`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync("jtsh-bug-report.md", body);
      ctx.stdout.write("bug: report saved to ./jtsh-bug-report.md — paste it into an issue manually.\n");
    }
    return 0;
  
  },

  async cat(ctx, args) {
    // in a pointer directory, `cat member` reads the scalar member's
    // value (nodeData); `cat dir` refuses like real cat; absolute paths
    // and unknown members fall through to the real fs.
    if (ctx.ptrCwd && args.length) {
      let hadPtrError = false;
      const rest = [];
      for (const file of args) {
        if (String(file).startsWith("/")) { rest.push(file); continue; }
        const res = builtins.ptrResolve(ctx, file);
        if (!res) { rest.push(file); continue; }
        if (res.isDir) { ctx.stderr.write(`cat: ${file}: is a directory\n`); hadPtrError = true; continue; }
        ctx.stdout.write(String(res.value) + "\n");
      }
      if (rest.length === 0) return hadPtrError ? 1 : 0;
      args = rest;
      if (hadPtrError) { /* still read the fs args below */ }
    }
    if (args.length === 0) {
      // No files — read from stdin (pipe input). Write the raw pipe
      // data so binary streams (gzip/zstd output) pass through bytes.
      const data = rawStdin;
      if (data === "") return 0;
      const endsNL = typeof data === "string"
        ? data.endsWith("\n")
        : data[data.length - 1] === 10;
      ctx.stdout.write(data);
      if (!endsNL) ctx.stdout.write("\n");
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
          ctx.stdout.write(text);
          if (!text.endsWith("\n")) ctx.stdout.write("\n");
        } else {
          ctx.stdout.write(bytes);
        }
      } catch (e) {
        hadError = true;
        ctx.stderr.write(`cat: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  
  },

  // ptrPwd(ctx) — the virtual path of the pointer-cwd stack (a box
  // root plus the pointer members we descended into).
  ptrPwd(ctx) {
    if (!ctx.ptrCwd) return "";
    return ctx.ptrCwd.stack.map((s) => s.name).join("/");
  },

  // ptrBox(ctx) — the box at the top of the pointer-cwd stack (null
  // when not in a pointer).
  ptrBox(ctx) {
    if (!ctx.ptrCwd || !ctx.ptrCwd.stack.length) return null;
    return ctx.ptrCwd.stack[ctx.ptrCwd.stack.length - 1].box;
  },

  // ptrResolve(ctx, path) — resolve a path relative to the pointer
  // cwd WITHOUT changing it (ls/find/cat): "." = the current box,
  // "member/member/…" descends through pointer members via nodeChild.
  // Returns { box, name, index, value, isDir, dirBox }: the resolved
  // box, the final component's member (or null for "."), whether it is
  // a directory (box) or a file (scalar), and the box to list when a
  // directory. Null when any component is missing or a mid-path
  // component is a scalar.
  ptrResolve(ctx, path) {
    const sh2 = ctx.otRt && ctx.otRt.sh2;
    if (!ctx.ptrCwd || !sh2 || !sh2.ptrMembers) return null;
    let box = builtins.ptrBox(ctx);
    const parts = String(path).split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0) return { box, name: null, index: -1, value: null, isDir: true, dirBox: box };
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const members = sh2.ptrMembers(box);
      const m = members.find((x) => x.name === part);
      if (!m) return null;
      const val = sh2.nodeChild(box, m.index);
      const vb = sh2.memBoxOf(val);
      if (i === parts.length - 1) {
        return { box, name: m.name, index: m.index, value: val, isDir: !!vb, dirBox: vb };
      }
      if (!vb) return null;   // a scalar mid-path is not a directory
      box = vb;
    }
    return null;
  },

  // ptrExec(ctx, args, path) — `find . -exec CMD ARGS '{}' ;` over a
  // pointer: run CMD with every `{}` replaced by the matched member
  // path, through the shell's own command runner (so a ptr-aware grep
  // resolves the path against the pointer). The command's stdout is
  // forwarded to find's stdout, like real -exec.
  ptrExec(ctx, args, path) {
    if (typeof ctx.runNestedCommand !== "function") {
      ctx.stderr.write("find: -exec needs the shell command runner\n");
      return Promise.resolve();
    }
    const q = (w) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(w)) ? String(w) : `'${String(w).replace(/'/g, `'\''`)}'`;
    const cmdline = args.map((a) => (a === "{}" ? path : q(a))).join(" ");
    return Promise.resolve(ctx.runNestedCommand(cmdline, "")).then((r) => {
      if (r && r.out) ctx.stdout.write(r.out);
      if (r && r.err) ctx.stderr.write(r.err);
    }).catch((e) => {
      ctx.stderr.write(`find: -exec: ${e && e.message ? e.message : e}\n`);
    });
  },

  // ptrLeave(ctx) — exit pointer mode, restoring the saved fs cwd.
  ptrLeave(ctx) {
    if (!ctx.ptrCwd) return;
    if (ctx.ptrCwd.savedFsCwd !== undefined) fs.cwd = ctx.ptrCwd.savedFsCwd;
    if (ctx.ptrCwd.savedPWD !== undefined) env.PWD = ctx.ptrCwd.savedPWD;
    ctx.ptrCwd = null;
  },

  async cd(ctx, args) {
    let dir = args[0] || env.HOME;
    if (dir === "-") {
      // cd - → the previous directory (and print it, like bash)
      if (!env.OLDPWD) {
        ctx.stderr.write("cd: OLDPWD not set\n");
        return 1;
      }
      dir = env.OLDPWD;
    }
    const sh2 = ctx.otRt && ctx.otRt.sh2;
    const isPtrTarget = String(dir).includes("\u0001mem:") ||
      (dir && typeof dir === "object" && Array.isArray(dir.arena));
    // an absolute path (or another pointer) while inside a pointer —
    // leave pointer mode and cd normally
    if (ctx.ptrCwd && (isPtrTarget || String(dir).startsWith("/") || String(dir) === "~")) {
      builtins.ptrLeave(ctx);
    }
    if (isPtrTarget) {
      // cd $ptr — enter the structure as a directory (the layout
      // registry's members are its children)
      const box = sh2 && sh2.memBoxOf ? sh2.memBoxOf(dir) : null;
      if (!box || !box.tag) {
        ctx.stderr.write(`cd: ${dir}: not a live pointer\n`);
        return 1;
      }
      if (!ctx.ptrCwd) {
        ctx.ptrCwd = { stack: [], savedFsCwd: fs.cwd, savedPWD: env.PWD };
      }
      ctx.ptrCwd.stack = [{ box, name: String(box) }];
      env.PWD = String(box);
      return 0;
    }
    if (ctx.ptrCwd) {
      if (dir === "..") {
        if (ctx.ptrCwd.stack.length > 1) {
          ctx.ptrCwd.stack.pop();
          env.PWD = builtins.ptrPwd(ctx);
        } else {
          builtins.ptrLeave(ctx);
        }
        return 0;
      }
      // cd MEMBER/MEMBER/… — descend through pointer members (a box is
      // a directory; a scalar is not)
      const parts = String(dir).split("/").filter(Boolean);
      for (const part of parts) {
        if (part === "..") {
          if (ctx.ptrCwd.stack.length > 1) ctx.ptrCwd.stack.pop();
          else { builtins.ptrLeave(ctx); return 0; }
          continue;
        }
        const cur = builtins.ptrBox(ctx);
        const members = (sh2 && sh2.ptrMembers ? sh2.ptrMembers(cur) : []);
        const m = members.find((x) => x.name === part);
        if (!m) {
          ctx.stderr.write(`cd: ${part}: no such member\n`);
          return 1;
        }
        const val = sh2.nodeChild(cur, m.index);
        const valBox = sh2.memBoxOf(val);
        if (!valBox) {
          ctx.stderr.write(`cd: ${part}: not a pointer member (a scalar)\n`);
          return 1;
        }
        ctx.ptrCwd.stack.push({ box: valBox, name: part });
      }
      env.PWD = builtins.ptrPwd(ctx);
      return 0;
    }
    try {
      await fs.list(dir);
      const r = fs._resolve(dir);
      env.OLDPWD = env.PWD;   // bash keeps OLDPWD for `cd -` / $OLDPWD
      fs.cwd = r;
      env.PWD = r;
      if (args[0] === "-") ctx.stdout.write(r + "\n");
      // cd into a remote mount may have just fetched (and cached) the
      // listing — surface the API usage from that fetch, like ls does.
      // (ls right after will show "cached just now" instead.)
      const rate = await fs.rateInfo(dir);
      if (rate && rate.limit > 0) {
        const used = Math.max(0, rate.limit - rate.remaining);
        ctx.stdout.write(`  (${rate.name}: ${used}/${rate.limit} API requests used ${rate.period})\n`);
      }
      return 0;
    } catch (e) {
      ctx.stderr.write(`cd: ${dir}: ${e.message}\n`);
      return 1;
    }
  
  },

  async chmod(ctx, args) {
    // chmod OCTAL file... — only the owner (or jtsh/root) may change a
    // file's mode. Modes are Unix-style: 600 = owner rw, 644 = +other r,
    // 755 = dir default, 700 = private dir.
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
      ctx.stderr.write("chmod OCTAL file...  (e.g. chmod 600 secret.txt · chmod 755 dir)\n");
      return args.length ? 0 : 2;
    }
    if (!/^[0-7]{3,4}$/.test(args[0])) {
      ctx.stderr.write(`chmod: invalid mode '${args[0]}' — use octal (600, 644, 755)\n`);
      return 2;
    }
    const mode = parseInt(args[0], 8);
    const user = env.USER || "jtsh";
    let hadError = false;
    for (const file of args.slice(1)) {
      const a = fs.attrOf(file);
      if (!a) {
        ctx.stderr.write(`chmod: ${file}: No such file or directory\n`);
        hadError = true;
        continue;
      }
      if (user !== "jtsh" && user !== "root" && user !== a.owner) {
        ctx.stderr.write(`chmod: ${file}: operation not permitted (owned by ${a.owner})\n`);
        hadError = true;
        continue;
      }
      fs.setAttr(file, { owner: a.owner, mode });
    }
    return hadError ? 1 : 0;
  
  },

  async chroot(ctx, args) {
    // chroot <dir>   — confine the shell to a new root (admin only)
    // chroot -       — return to the real root
    if (!ctx.isPrivilegedUser()) {
      ctx.stderr.write("chroot: operation not permitted (admin only)\n");
      return 1;
    }
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
      ctx.stdout.write("chroot <dir> — confine the shell to a new root\n");
      ctx.stdout.write("chroot -      — return to the real root\n");
      return args.length ? 0 : 2;
    }
    if (args[0] === "-" || args[0] === "/") {
      if (fs.root && fs.root !== "/") {
        fs.cwd = fs.chrootSavedCwd || "/home";
        fs.root = "/";
        ctx.stdout.write("chroot: returned to the real root\n");
      } else {
        ctx.stdout.write("chroot: not inside a chroot\n");
      }
      rl.setPrompt(shellPrompt());
      rl.prompt();
      return 0;
    }
    const r = fs._resolve(args[0]);
    let st;
    try { st = await fs.stat(r); } catch (e) {
      ctx.stderr.write(`chroot: ${args[0]}: ${e.message}\n`);
      return 1;
    }
    if (!st || st.type !== "dir") {
      ctx.stderr.write(`chroot: ${args[0]}: not a directory\n`);
      return 1;
    }
    fs.chrootSavedCwd = fs.cwd;
    fs.root = r;
    fs.cwd = r;
    ctx.stdout.write(`chroot: changed root to ${args[0]} — "/" is now ${r}\n`);
    rl.setPrompt(shellPrompt());
    rl.prompt();
    return 0;
  
  },

  async clear(ctx, args) {
    // ANSI clear-screen (keeps the readline scrollback, like real clear)
    ctx.stdout.write("\x1b[2J\x1b[H");
    return 0;
  
  },

  async cp(ctx, args) {
    if (args.length < 2) {
      ctx.stderr.write("cp: missing operand\n");
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
      ctx.stderr.write(`cp: ${src}: ${e.message}\n`);
      return 1;
    }
  
  },

  async echo(ctx, args) {
    ctx.stdout.write(args.join(" ") + "\n");
    return 0;
  
  },

  async exit(ctx, args) {
    ctx.exit();
  
  },

  async export(ctx, args) {
    // export [NAME[=VALUE]...] — set environment variables.
    // `export` or `export -p` prints all variables in POSIX form.
    // `export NAME=value` sets NAME to value (split on the first '=');
    // `export NAME` sets NAME to an empty string, like bash.
    // Invalid identifiers are reported and skipped; exit status is 1
    // if any argument was invalid.
    if (args.length === 0 || (args.length === 1 && args[0] === "-p")) {
      for (const key of Object.keys(env).sort()) {
        ctx.stdout.write(`export ${key}=${env[key]}\n`);
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
        ctx.stderr.write(`export: '${arg}': not a valid identifier\n`);
        continue;
      }
      if (isReadonly(name)) {
        hadError = true;
        ctx.stderr.write(`export: ${name}: readonly variable\n`);
        continue;
      }
      env[name] = eq === -1 ? "" : arg.slice(eq + 1);
    }
    return hadError ? 1 : 0;
  
  },

  async false(ctx, args) {
    // Always fails (exit 1) — handy with `||`
    return 1;
  
  },

  async find(ctx, args) {
    // TWO finds under one name, dispatched on the first argument's shape:
    //   find UTF8_STRING…          → the directory search below
    //   find \u0001mem:… …         → a sourced C find() over a pointer tree
    // (a mem handle is the opaque \u0001mem:<id>:<offset> string; route it
    // to the function table, where the transpiled C find walks the list).
    if ((ctx.nodeEnv && ctx.nodeEnv.SH2_DEBUG_FIND)) ctx.stderr.write(`[find] arg0=${JSON.stringify(String(args[0] ?? ""))} hasFn=${ctx.otRt && ctx.otRt.sh2 && ctx.otRt.sh2.functions ? ctx.otRt.sh2.functions.has("find") : "no-ctx.otRt"}\n`);
    if (String(args[0] ?? "").includes("\u0001mem:") &&
        ctx.otRt && ctx.otRt.sh2 && ctx.otRt.sh2.functions && ctx.otRt.sh2.functions.has("find")) {
      const v = await ctx.otRt.sh2.fnCall("find", args);
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
    let print = true, printExplicit = false;
    let execCmd = null;   // find . -exec CMD ARGS '{}' ;

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
          ctx.stderr.write(`find: missing argument to '${a}'\n`);
          return;
        }
        namePatterns.push({ re: globToRe(args[++i], a === "-iname") });
      } else if (a === "-type") {
        if (i + 1 >= args.length) {
          ctx.stderr.write(`find: missing argument to '-type'\n`);
          return;
        }
        const t = args[++i];
        if (t !== "f" && t !== "d") {
          ctx.stderr.write(`find: unknown type '${t}' (use 'f' for file or 'd' for directory)\n`);
          return;
        }
        types.add(t);
      } else if (a === "-maxdepth" || a === "-mindepth") {
        if (i + 1 >= args.length) {
          ctx.stderr.write(`find: missing argument to '${a}'\n`);
          return;
        }
        const n = parseInt(args[++i], 10);
        if (isNaN(n) || n < 0) {
          ctx.stderr.write(`find: invalid depth '${args[i]}'\n`);
          return;
        }
        if (a === "-maxdepth") maxDepth = n;
        else minDepth = n;
      } else if (a === "-print") {
        print = true;
        printExplicit = true;
      } else if (a === "-exec") {
        // find . -exec CMD ARGS '{}' ; — run CMD per match with {}
        // replaced by the matched path. `;` or `+` terminates; also
        // accept end-of-args (the line splitter may strip the `;`).
        const cmdArgs = [];
        i++;
        while (i < args.length && args[i] !== ";" && args[i] !== "+") cmdArgs.push(args[i++]);
        if (cmdArgs.length === 0) {
          ctx.stderr.write(`find: missing argument to '-exec'\n`);
          return 1;
        }
        execCmd = { args: cmdArgs };
      } else if (a === "--") {
        // Everything after -- is a start path
        for (const rest of args.slice(i + 1)) paths.push(rest);
        break;
      } else if (a.startsWith("-")) {
        ctx.stderr.write(`find: unknown option '${a}'\n`);
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

    if (execCmd && !printExplicit) print = false;   // -exec suppresses the default print

    // ── the POINTER walk: `find .` inside a cd'd-into pointer. The
    // layout registry turns the structure into a tree: pointer members
    // are directories (recursed via nodeChild), scalar members are
    // files (NULL — "" / "0" — is skipped). Paths print relative to the
    // pointer root with the find "./" convention.
    if (ctx.ptrCwd && !paths.some((p) => String(p).startsWith("/"))) {
      const sh2 = ctx.otRt && ctx.otRt.sh2;
      const seen = new Set();
      let hadError = false;
      const walkPtr = async (box, path, depth) => {
        const members = (sh2 && sh2.ptrMembers ? sh2.ptrMembers(box) : []);
        for (const m of members) {
          const val = sh2.nodeChild(box, m.index);
          const vb = sh2.memBoxOf(val);
          if (vb) {
            const full = path + "/" + m.name;
            if (matched(m.name, "d", depth + 1) && print) ctx.stdout.write(full + "/\n");
            if (depth + 1 < maxDepth && !seen.has(String(vb))) {
              seen.add(String(vb));
              await walkPtr(vb, full, depth + 1);
            }
          } else {
            // scalar member — skip the NULL sentinel ("0" / "")
            if (String(val) === "" || String(val) === "0") continue;
            const full = path + "/" + m.name;
            if (matched(m.name, "f", depth + 1)) {
              if (print) ctx.stdout.write(full + "\n");
              if (execCmd) await builtins.ptrExec(ctx, execCmd.args, full);
            }
          }
        }
      };
      for (const path of paths) {
        // resolve the start point relative to the pointer cwd
        const res = builtins.ptrResolve(ctx, path);
        if (!res) { ctx.stderr.write(`find: ${path}: no such member\n`); hadError = true; continue; }
        const base = path === "." ? "." : "./" + res.name;
        if (!res.isDir) {
          if (matched(res.name, "f", 0) && print) ctx.stdout.write(base + "\n");
          continue;
        }
        if (matched(path === "." ? "." : res.name, "d", 0) && print) ctx.stdout.write(base + (path === "." ? "/" : "/") + "\n");
        seen.add(String(res.dirBox));
        await walkPtr(res.dirBox, base, 0);
      }
      return hadError ? 1 : 0;
    }

    // Recursive walk. `dir` is a resolved absolute path; `depth` is the
    // depth of `dir` itself (start points are depth 0).
    const walk = async (dir, depth) => {
      if (isRemote(dir)) {
        hadError = true;
        if (!skippedRemote) {
          ctx.stderr.write(`find: skipping remote mount ${dir} (name specific files to search them)\n`);
          skippedRemote = true;
        }
        return;
      }
      let entries;
      try { entries = await fs.list(dir); } catch (e) {
        hadError = true;
        ctx.stderr.write(`find: ${dir}: ${e.message}\n`);
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
          ctx.stdout.write(full + (type === "d" ? "/" : "") + "\n");
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
        ctx.stderr.write(`find: ${path}: ${e.message}\n`);
        continue;
      }
      const type = st.type === "dir" ? "d" : "f";
      const base = r.split("/").pop() || "/";
      if (matched(base, type, 0) && print) {
        ctx.stdout.write((r === "/" ? "/" : r + (type === "d" ? "/" : "")) + "\n");
      }
      if (type !== "d") continue;
      if (isRemote(r)) {
        hadError = true;
        ctx.stderr.write(`find: skipping remote mount ${r} (name specific files to search them)\n`);
        continue;
      }
      if (0 < maxDepth) await walk(r, 0);
    }
    return hadError ? 1 : 0;
  
  },

  async rg(ctx, args) {
    // ripgrep-ish: recursive by default. Forward to grep; with no FILE
    // argument, search the current directory (the pointer root inside a
    // pointer, the fs cwd otherwise). `rg .` searches everything.
    // the first non-flag arg is the pattern; anything after it is a
    // FILE. With no FILE, rg searches the current directory recursively.
    const nonFlag = args.filter((a) => !String(a).startsWith("-"));
    const hasFile = nonFlag.length > 1;
    return builtins.grep(ctx, ["-r", ...args, ...(hasFile ? [] : ["."])]);
  },

  async go(ctx, args) {
    // go run main.go [args…] — the REAL Go toolchain (cmd/compile +
    // cmd/link, cross-compiled to GOOS=js GOARCH=wasm) running in the
    // shell. See src/go.js and build-wasm-go.sh.
    return await ctx.goCmd(args);
  
  },

  async grep(ctx, args) {
    // grep [-i] [-n] [-v] [-c] [-l] [-r] [-o] [-e PATTERN] [--] PATTERN [FILE...]
    // With no FILE arguments, searches stdin (pipe input).
    let ignoreCase = false, lineNumber = false, invert = false;
    let count = false, filesWithMatches = false, recursive = false;
    let onlyMatching = false, labelNever = false, labelAlways = false;
    let pattern = null, patternExplicit = false;
    const patterns = [];
    let files = [];
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
      else if (!optsDone && (a === "-h" || a === "--no-filename")) labelNever = true;
      else if (!optsDone && (a === "-H" || a === "--with-filename")) labelAlways = true;
      else if (!optsDone && (a === "-e" || a === "--regexp")) {
        if (i + 1 >= args.length) {
          ctx.stderr.write(`grep: option requires an argument -- '${a}'\n`);
          return 2;
        }
        pattern = args[++i];
        patterns.push(pattern);
        patternExplicit = true;
      } else if (!optsDone && a.startsWith("--")) {
        ctx.stderr.write(`grep: unrecognized option '${a}'\n`);
        return 2;
      } else if (!optsDone && a.startsWith("-") && a.length > 1) {
        // Bundled short flags, e.g. -in or -cv
        let ok = true;
        for (const ch of a.slice(1)) {
          if (shortFlags[ch]) shortFlags[ch]();
          else { ok = false; break; }
        }
        if (!ok) {
          ctx.stderr.write(`grep: invalid option -- '${a}'\n`);
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
      ctx.stderr.write("grep: missing pattern\n");
      return 2;
    }
    // Multiple -e patterns match if ANY of them matches (OR)
    const patternSource = patterns.map(p => `(?:${p})`).join("|");

    let re;
    try {
      re = new RegExp(patternSource, ignoreCase ? "i" : "");
    } catch (e) {
      ctx.stderr.write(`grep: invalid regular expression: '${patterns.join("', '")}'\n`);
      return 2;
    }

    // Remote mounts would require crawling the network; refuse that and
    // only grep them when a specific file is named.
    const REMOTE = ["/http/", "/github/", "/mount/github/", "/gitlab/", "/mount/gitlab/", "/git/", "/mount/git/"];
    const isRemote = (p) => REMOTE.some(pre => p === pre.slice(0, -1) || p.startsWith(pre));

    let showLabel = (files.length > 1 || recursive || labelAlways) && !labelNever;

    const processContent = (content, label) => {
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop(); // drop trailing newline
      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]) !== invert) hits.push({ num: i + 1, text: lines[i] });
      }
      if (count) {
        ctx.stdout.write((showLabel ? label + ":" : "") + hits.length + "\n");
      } else if (filesWithMatches) {
        if (hits.length > 0) ctx.stdout.write(label + "\n");
      } else if (onlyMatching && !invert) {
        // -o: print each match on its own line (GNU: no effect with -v).
        // Skip zero-length matches to avoid a position walk.
        const gm = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        for (const h of hits) {
          let m;
          while ((m = gm.exec(h.text)) !== null) {
            if (m[0].length === 0) { gm.lastIndex++; continue; }
            ctx.stdout.write(
              (showLabel ? label + ":" : "") +
              (lineNumber ? h.num + ":" : "") +
              m[0] + "\n"
            );
          }
        }
      } else {
        for (const h of hits) {
          ctx.stdout.write(
            (showLabel ? label + ":" : "") +
            (lineNumber ? h.num + ":" : "") +
            h.text + "\n"
          );
        }
      }
      return hits.length;
    };

    // ── inside a pointer: search the structure's scalar members. A
    // directory arg ("." or a pointer member) walks the subtree; a
    // scalar member is searched directly. Labels are the member paths
    // (suppressed by -h, forced by -H).
    if (ctx.ptrCwd && files.some((f) => !String(f).startsWith("/"))) {
      const sh2 = ctx.otRt && ctx.otRt.sh2;
      let hadError = false;
      let anyHits = 0;
      const seen = new Set();   // boxes already visited — a cycle must not loop
      const searchBox = async (box, path) => {
        const members = (sh2 && sh2.ptrMembers ? sh2.ptrMembers(box) : []);
        for (const m of members) {
          const val = sh2.nodeChild(box, m.index);
          const vb = sh2.memBoxOf(val);
          const full = path + "/" + m.name;
          if (vb) {
            if (!seen.has(String(vb))) { seen.add(String(vb)); await searchBox(vb, full); }
            continue;
          }
          if (String(val) === "" || String(val) === "0") continue;
          anyHits += processContent(String(val), full);
        }
      };
      const fsFiles = [];
      let sawDir = false;
      for (const file of files) {
        if (String(file).startsWith("/")) { fsFiles.push(file); continue; }
        const res = builtins.ptrResolve(ctx, file);
        if (!res) { hadError = true; ctx.stderr.write(`grep: ${file}: no such member\n`); continue; }
        if (!res.isDir) {
          if (String(res.value) === "" || String(res.value) === "0") continue;
          anyHits += processContent(String(res.value), file === "." ? "" : String(file));
          continue;
        }
        sawDir = true;
        if (!labelNever) showLabel = true;   // multi-member hits get paths
        const start = file === "." ? "." : "./" + res.name;
        seen.add(String(res.dirBox));
        await searchBox(res.dirBox, start);
      }
      // a directory search spans multiple members — label the hits
      // (unless -h suppresses it)
      if (sawDir && !labelNever) {
        // force the label on by reusing processContent's showLabel path
      }
      files = fsFiles;
      if (files.length === 0) return (hadError ? 2 : (anyHits > 0 ? 0 : 1));
    }

    if (files.length === 0) {
      const hits = processContent(ctx.stdin, "(standard input)");
      return hits > 0 ? 0 : 1;
    }

    // grep exit status: 0 if any line matched, 1 if none did, 2 on error
    let hadError = false;
    let anyHits = 0;

    // Recursively collect files under a directory
    const walk = async (dir) => {
      if (isRemote(dir)) {
        hadError = true;
        ctx.stderr.write(`grep: skipping remote mount ${dir} (name specific files to search them)\n`);
        return;
      }
      let entries;
      try { entries = await fs.list(dir); } catch (e) {
        hadError = true;
        ctx.stderr.write(`grep: ${dir}: ${e.message}\n`);
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
            ctx.stderr.write(`grep: ${full}: ${e.message}\n`);
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
        ctx.stderr.write(`grep: skipping remote mount ${r} (name specific files to search them)\n`);
        continue;
      }
      try {
        const st = await fs.stat(file);
        if (st.type === "dir") {
          if (recursive) await walk(r);
          else {
            hadError = true;
            ctx.stderr.write(`grep: ${file}: Is a directory\n`);
          }
          continue;
        }
        const content = await fs.read(file);
        anyHits += processContent(content, r);
      } catch (e) {
        hadError = true;
        ctx.stderr.write(`grep: ${file}: ${e.message}\n`);
      }
    }
    if (hadError) return 2;
    return anyHits > 0 ? 0 : 1;
  
  },

  async head(ctx, args) {
    // head [-n N] [file...] — print the first N lines (default 10).
    // With no file arguments, reads from stdin (i.e. a pipe).
    let count = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" || a === "--lines") {
        count = parseInt(args[i + 1], 10);
        if (isNaN(count)) {
          ctx.stderr.write(`head: invalid number of lines: '${args[i + 1]}'\n`);
          return 2;
        }
        i++;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10);
      } else if (/^\d+$/.test(a)) {
        count = parseInt(a, 10);   // friendly: `tail 1` == `tail -n 1`
      } else if (a.startsWith("-")) {
        ctx.stderr.write(`head: invalid option -- '${a}'\n`);
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
      ctx.stdout.write(lines.slice(0, count).join("\n") + "\n");
    };

    if (files.length === 0) {
      printLines(ctx.stdin);
      return 0;
    }
    let hadError = false;
    for (const file of files) {
      try {
        const content = await fs.read(file);
        if (files.length > 1) ctx.stdout.write(`==> ${file} <==\n`);
        printLines(content);
      } catch (e) {
        hadError = true;
        ctx.stderr.write(`head: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  
  },

  async help(ctx, args) {
    ctx.stdout.write(`jtsh — minimal shell for the virtual filesystem

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
  bash2js         Transpile bash to JavaScript (otranspilerl)
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

  async jobs(ctx, args) {
    // jobs — list background jobs (&): [id] pid status cmd
    const list = ctx.getBgJobs().list();
    if (list.length === 0) {
      ctx.stdout.write("jobs: no background jobs\n");
      return 0;
    }
    for (const j of list) {
      const status = j.running ? "running"
        : j.killed ? "killed"
        : j.code === 0 ? "done"
        : `failed (${j.code})`;
      ctx.stdout.write(`[${j.id}] ${j.pid}  ${status.padEnd(14)} ${j.cmd}${j.minimized ? "  (minimized)" : ""}\n`);
    }
    return 0;
  
  },

  async kill(ctx, args) {
    // kill <id|pid> — terminate a background job (exit 137); dismiss a
    // finished one from the job table
    if (args.length !== 1) {
      ctx.stderr.write("kill: usage: kill <job-id|pid>\n");
      return 2;
    }
    const code = ctx.getBgJobs().kill(args[0]);
    if (code === 127) ctx.stderr.write(`kill: no such job '${args[0]}'\n`);
    return code;
  
  },

  async ls(ctx, args) {
    // Parse flags: -l (long format with permissions/size/date)
    let long = false;
    const dirs = [];
    for (const a of args) {
      if (a === "-l" || a === "--long" || a === "-la" || a === "-al") {
        long = true;
      } else if (a.startsWith("-")) {
        ctx.stderr.write(`ls: invalid option -- '${a}'\n`);
        return 2;
      } else {
        dirs.push(a);
      }
    }
    if (dirs.length === 0) dirs.push(".");
    // in a pointer directory, list the layout-registry members (pointer
    // members get the dir marker, scalar members are files; NULL
    // sentinels are hidden)
    if (ctx.ptrCwd && dirs.every((d) => !String(d).startsWith("/"))) {
      const sh2 = ctx.otRt && ctx.otRt.sh2;
      let hadError = false;
      for (const dir of dirs) {
        const res = builtins.ptrResolve(ctx, dir);
        if (!res) { ctx.stderr.write(`ls: ${dir}: no such member\n`); hadError = true; continue; }
        if (!res.isDir) {
          if (String(res.value) === "" || String(res.value) === "0") continue;  // NULL sentinel
          ctx.stdout.write(res.name + "\n");
          continue;
        }
        const members = (sh2 && sh2.ptrMembers ? sh2.ptrMembers(res.dirBox) : []);
        for (const m of members) {
          const val = sh2.nodeChild(res.dirBox, m.index);
          const vb = sh2.memBoxOf(val);
          if (!vb && (String(val) === "" || String(val) === "0")) continue;
          ctx.stdout.write(m.name + (vb ? "/" : "") + (long ? "\t" : "") + "\n");
        }
      }
      return hadError ? 1 : 0;
    }
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
          ctx.stdout.write(output);
          continue;
        }
        const output = await fs.formatList(dir, { long });
        if (!output) continue;
        if (dirs.length > 1) ctx.stdout.write(`${dir}:\n`);
        ctx.stdout.write(output);
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
          ctx.stdout.write(`  (cached ${formatAge(cacheNote.age)} — API unavailable, stale)\n`);
        } else if (rate && rate.limit > 0) {
          // Fresh request — report the API's rolling-hour usage from the
          // response headers (exact for the IP, not an estimate).
          const used = Math.max(0, rate.limit - rate.remaining);
          ctx.stdout.write(`  (${rate.name}: ${used}/${rate.limit} API requests used ${rate.period})\n`);
        } else if (cacheNote) {
          // Served from cache — a just-completed cd fetched and cached
          // this dir, so an ls right after hits the cache (age < 1min).
          ctx.stdout.write(`  (cached ${formatAge(cacheNote.age)})\n`);
        }
      } catch (e) {
        hadError = true;
        ctx.stderr.write(`ls: ${dir}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  
  },

  async man(ctx, args) {
    // man [command]       — show the manual page for a command
    // man -k <keyword>    — search manual pages (like apropos)
    // man                 — index of all manual pages
    if (args.length === 0) {
      ctx.stdout.write("Manual pages available in this shell:\n\n");
      for (const line of manIndex()) ctx.stdout.write("  " + line + "\n");
      ctx.stdout.write(`\nUse "man <command>" for a command's page, "man -k <word>" to search.\n`);
      return 0;
    }
    if (args[0] === "-k" || args[0] === "--apropos") {
      const term = args[1];
      if (!term) {
        ctx.stderr.write("man: what manual page do you want? (man -k <keyword>)\n");
        return 2;
      }
      const results = searchManPages(term);
      if (results.length === 0) {
        ctx.stdout.write(`Nothing appropriate for "${term}".\n`);
        return 1;
      }
      for (const line of results) ctx.stdout.write("  " + line + "\n");
      return 0;
    }
    if (args[0] === "-h" || args[0] === "--help") {
      ctx.stdout.write(MAN_PAGES.man + "\n");
      return 0;
    }
    if (args.length > 1 && args[0] !== "-k") {
      ctx.stderr.write(`man: too many arguments (try: man <command> or man -k <keyword>)\n`);
      return 2;
    }
    const page = await getManPage(args[0], { fs, wasmerReg });
    if (!page) {
      ctx.stderr.write(`man: no manual entry for ${args[0]}\n`);
      ctx.stderr.write(`(see the index: "man" alone, or search with "man -k <keyword>")`);
      ctx.stderr.write("\n");
      return 1;
    }
    ctx.stdout.write(page.text + "\n");
    return 0;
  
  },

  async mkdir(ctx, args) {
    if (args.length === 0) {
      ctx.stderr.write("mkdir: missing operand\n");
      return 2;
    }
    let hadError = false;
    for (const dir of args) {
      try {
        const r = fs._resolve(dir);
        await fs.write(r + "/.directory", "");
      } catch (e) {
        hadError = true;
        ctx.stderr.write(`mkdir: ${dir}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  
  },

  async mount(ctx, args) {
    // mount                              — list current mounts
    // mount github:user/repo /mymount    — attach a GitHub repo at a path
    // mount --help                       — usage
    if (args.length === 0 || args[0] === "-l" || args[0] === "--list") {
      ctx.stdout.write(fs.mountTable());
      return 0;
    }
    if (args[0] === "-h" || args[0] === "--help") {
      ctx.stdout.write(`mount — attach a remote repo as a filesystem

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
      if (!ctx.isPrivilegedUser()) {
        ctx.stderr.write("mount: operation not permitted (admin only)\n");
        return 1;
      }
      const bindSrc = args[1];
      const bindDst = args[2];
      if (!bindSrc || !bindDst) {
        ctx.stderr.write("mount: usage: mount --bind <src> <dst>\n");
        return 2;
      }
      const sr = fs._resolve(bindSrc);
      const dr = fs._resolve(bindDst);
      if (fs.mounts.some((m) => m.prefix === dr)) {
        ctx.stderr.write(`mount: ${dr}: already a mount point (unmount ${dr} first)\n`);
        return 1;
      }
      try {
        fs.bindMount(sr, dr);
        ctx.stdout.write(`mounted ${bindSrc} on ${bindDst} (bind)\n`);
        return 0;
      } catch (e) {
        ctx.stderr.write(`mount: ${e.message}\n`);
        return 1;
      }
    }
    const spec = args[0];
    const target = args[1];
    if (!target) {
      ctx.stderr.write(`mount: usage: mount github:user/repo /mymount · mount --bind <src> <dst>\n`);
      return 2;
    }
    if (args.length > 2) {
      ctx.stderr.write(`mount: too many arguments\n`);
      return 2;
    }
    const r = fs._resolve(target);
    if (fs.mounts.some((m) => m.prefix === r)) {
      ctx.stderr.write(`mount: ${r}: already a mount point (unmount ${r} first)\n`);
      return 1;
    }
    try {
      const record = fs.mountSpec(spec, r);
      ctx.stdout.write(`mounted ${record.name} at ${record.prefix}\n`);
      return 0;
    } catch (e) {
      ctx.stderr.write(`mount: ${e.message}\n`);
      return 1;
    }
  
  },

  async mv(ctx, args) {
    if (args.length < 2) {
      ctx.stderr.write("mv: missing operand\n");
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
      ctx.stderr.write(`mv: ${src}: ${e.message}\n`);
      return 1;
    }
  
  },

  async nethack(ctx, args) {
    // nethack [--demo] — real NetHack 3.6.7 (emscripten WASM) via
    // win/shim window system. Browser: full-screen TTY game. CLI:
    // --demo autoplays headlessly. See src/nethack.js.
    return await nethackCmd(args);
  
  },

  async pwd(ctx, args) {
    if (ctx.ptrCwd) {
      ctx.stdout.write((fs.view ? fs.view(env.PWD) : env.PWD) + "\n");
      return 0;
    }
    ctx.stdout.write((fs.view ? fs.view(fs.cwd) : fs.cwd) + "\n");
    return 0;
  
  },

  async qsort(ctx, args) {
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
    const help = () => ctx.stdout.write(
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
    if (!compar) { ctx.stderr.write("qsort: usage: qsort ARRAY COMPARFN\n"); return 2; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      ctx.stderr.write(`qsort: '${name}': not a valid variable name\n`);
      return 2;
    }
    await ctx.ensureOtRuntime();
    const sh2 = ctx.otRt.sh2;
    if (!sh2.functions || !sh2.functions.has(compar)) {
      ctx.stderr.write(`qsort: no function '${compar}' (define it first: ${compar}() { … })\n`);
      return 1;
    }
    const arr = sh2.vars[name];
    if ((ctx.nodeEnv && ctx.nodeEnv.QSORT_DEBUG)) ctx.stderr.write(`QSORT_DEBUG vars.${name}=${JSON.stringify(arr)} typeof=${typeof arr} isArr=${Array.isArray(arr)} env.${name}=${JSON.stringify(env[name])}\n`);
    if (!Array.isArray(arr)) {
      ctx.stderr.write(`qsort: '${name}' is not an array\n`);
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
      if (typeof process !== "undefined" && ctx.stdout && typeof ctx.stdout.write === "function") targets.push(ctx.stdout);
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
      ctx.stderr.write(`qsort: ${compar}: ${e.message}\n`);
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

  async readonly(ctx, args) {
    // readonly [NAME[=VALUE]...] — mark variables read-only.
    // `readonly` / `readonly -p` — list them. Reassignment (export /
    // transpiled setVar) refuses with "readonly variable" and $? = 1.
    if (args.length === 0 || (args.length === 1 && args[0] === "-p")) {
      for (const name of listReadonly().sort()) {
        const v = env[name] !== undefined ? env[name] : "";
        ctx.stdout.write(`readonly ${name}=${v}\n`);
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
        ctx.stderr.write(`readonly: '${arg}': not a valid identifier\n`);
        continue;
      }
      if (eq !== -1) {
        if (isReadonly(name) && env[name] !== undefined) {
          hadError = true;
          ctx.stderr.write(`readonly: ${name}: readonly variable\n`);
          continue;
        }
        env[name] = arg.slice(eq + 1);
      }
      markReadonly(name);
    }
    return hadError ? 1 : 0;
  
  },

  async rm(ctx, args) {
    if (args.length === 0) {
      ctx.stderr.write("rm: missing operand\n");
      return 2;
    }
    // tolerate -r/--recursive (the VFS has no subdirectories to recurse
    // into — materialized /bin commands are plain files) and -f (ignore
    // missing files), so `rm -r /bin/mimecroft.sh` works like real rm
    const files = [];
    let force = false;
    for (const a of args) {
      if (a === "-r" || a === "-R" || a === "--recursive") continue;
      if (a === "-f" || a === "--force") { force = true; continue; }
      if (a.startsWith("--")) continue;
      files.push(a);
    }
    if (files.length === 0) return 0;
    let hadError = false;
    for (const file of files) {
      if (force) { try { await fs.remove(file); continue; } catch { continue; } }
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
        ctx.stderr.write(`rm: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  
  },

  async set(ctx, args) {
    // set                     — print shell variables
    // set -- a b c            — set the positional parameters ($1 $2 $3)
    // set a b c               — same (first non-option arg starts $1)
    // set -eux / set +eux     — option flags (accepted and stored; -x is
    //                           honoured natively, -e/-u are no-ops in an
    //                           interactive shell by POSIX design)
    // set -o errexit|nounset|xtrace — long forms
    if (args.length === 0) {
      for (const key of Object.keys(env).sort()) {
        ctx.stdout.write(`${key}=${env[key]}\n`);
      }
      return 0;
    }
    const OPTION_NAMES = { errexit: "e", nounset: "u", xtrace: "x", noglob: "f", allexport: "a" };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { setPositional(args.slice(i + 1)); return 0; }
      if (a === "-o" || a === "+o") {
        const name = args[i + 1];
        if (!name) { ctx.stderr.write(`set: ${a}: needs an option name\n`); return 2; }
        const f = OPTION_NAMES[name];
        if (!f) { ctx.stderr.write(`set: -o: ${name}: invalid option name\n`); return 2; }
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

  async sleep(ctx, args) {
    // sleep [N] — delay for N seconds (floats ok; default 1). Needed by
    // game loops (mimecroft) and scripts.
    let secs = 1;
    if (args.length > 0) {
      secs = parseFloat(args[0]);
      if (isNaN(secs) || secs < 0) {
        ctx.stderr.write(`sleep: invalid time interval '${args[0]}'\n`);
        return 2;
      }
    }
    await new Promise((r) => setTimeout(r, Math.round(secs * 1000)));
    return 0;
  
  },

  async source(ctx, args) {
    if (args.length === 0) {
      ctx.stderr.write("source: filename argument required\n");
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
      ctx.stderr.write(`source: ${file}: ${e.message}\n`);
      return 1;
    }
    const lang = sourceLangOf(resolved);
    try {
      return await ctx.runSourceContent(content, lang, args.slice(1));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      ctx.stderr.write(`source: ${file}: ${msg}\n`);
      return 1;
    }
  
  },

  async su(ctx, args) {
    // su                  → drop to nobody (unprivileged)
    // su <name>           → switch to that user (su jtsh / su root → back)
    let target = (args[0] || "nobody").trim().toLowerCase();
    if (target === "-") target = "nobody";
    if (!/^[a-z_][a-z0-9_-]*$/.test(target)) {
      ctx.stderr.write(`su: invalid user name '${target}'\n`);
      return 1;
    }
    if (env.USER === target) {
      ctx.stdout.write(`su: already running as ${target}\n`);
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
    ctx.stdout.write(`su: switched to ${target} — ${unpriv ? "unprivileged" : "user"}\n`);
    ctx.stdout.write(`    HOME=${env.HOME} · run 'su jtsh' to return\n`);
    rl.setPrompt(shellPrompt());
    rl.prompt();
    return 0;
  
  },

  async tail(ctx, args) {
    // tail [-n N] [file...] — print the last N lines (default 10).
    // With no file arguments, reads from stdin (i.e. a pipe).
    let count = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" || a === "--lines") {
        count = parseInt(args[i + 1], 10);
        if (isNaN(count)) {
          ctx.stderr.write(`tail: invalid number of lines: '${args[i + 1]}'\n`);
          return 2;
        }
        i++;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10);
      } else if (/^\d+$/.test(a)) {
        count = parseInt(a, 10);   // friendly: `tail 1` == `tail -n 1`
      } else if (a.startsWith("-")) {
        ctx.stderr.write(`tail: invalid option -- '${a}'\n`);
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
      ctx.stdout.write(out.join("\n") + "\n");
    };

    if (files.length === 0) {
      printLines(ctx.stdin);
      return 0;
    }
    let hadError = false;
    for (const file of files) {
      try {
        const content = await fs.read(file);
        if (files.length > 1) ctx.stdout.write(`==> ${file} <==\n`);
        printLines(content);
      } catch (e) {
        hadError = true;
        ctx.stderr.write(`tail: ${file}: ${e.message}\n`);
      }
    }
    return hadError ? 1 : 0;
  
  },

  async true(ctx, args) {
    // Always succeeds (exit 0) — handy with `&&`
    return 0;
  
  },

  async unmount(ctx, args) {
    // unmount /mymount — detach a user-created mount
    if (!args[0] || args[0] === "-h" || args[0] === "--help") {
      ctx.stdout.write(`unmount — detach a user-created mount

unmount /mymount
`);
      return 0;
    }
    const target = args[0];
    try {
      const r = fs._resolve(target);
      const removed = fs.unmount(r);
      ctx.stdout.write(`unmounted ${removed.prefix} (${removed.name})\n`);
      return 0;
    } catch (e) {
      ctx.stderr.write(`unmount: ${target}: ${e.message}\n`);
      return 1;
    }
  
  },

  async unset(ctx, args) {
    // unset [NAME...] — remove variables from the environment AND the
    // transpiled persistent state (env / otVars / ctx.otRt.sh2.vars stay in
    // sync, so native and transpiled code agree). Flags (-v/-f) are
    // accepted and ignored; `unset` with no args is a no-op, like bash.
    let hadError = false;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
        hadError = true;
        ctx.stderr.write(`unset: '${arg}': not a valid identifier\n`);
        continue;
      }
      delete env[arg];
      otVars.delete(arg);
      try { delete ctx.otRt.sh2.vars[arg]; } catch {}
    }
    return hadError ? 1 : 0;
  
  },

  async wait(ctx, args) {
    // wait [id|pid] — wait for a background job, or all of them
    if (args.length > 1) {
      ctx.stderr.write("wait: too many arguments\n");
      return 2;
    }
    const code = await ctx.getBgJobs().wait(args[0]);
    if (code === 127 && args[0] !== undefined) {
      ctx.stderr.write(`wait: no such job '${args[0]}'\n`);
    }
    return code;
  
  },

  async wasmer(ctx, args) {
    // wasmer list | install <pkg> | search <term> — WASM package
    // manager. The browser fetches the same prebuilt binaries over
    // HTTP; the CLI reads them from the repo's www/wasm-bin/ dir.
    if (!args[0] || args[0] === "help") {
      ctx.stdout.write(`wasmer — WASM package manager for browser shell

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
        ctx.stdout.write(`  ${name.padEnd(12)} ${desc}\n`);
      }
      return 0;
    }
    if (args[0] === "search") {
      const results = wasmerReg.search(args[1] || "");
      if (results.length === 0) {
        ctx.stdout.write(`No packages match "${args[1]}".\n`);
        return 1;
      }
      for (const { name, desc } of results) {
        ctx.stdout.write(`  ${name.padEnd(12)} ${desc}\n`);
      }
      return 0;
    }
    if (args[0] === "install") {
      const name = args[1];
      if (!name) {
        ctx.stderr.write("wasmer: install needs a package name\n");
        return 2;
      }
      if (!wasmerReg.list().some((p) => p.name === name)) {
        ctx.stderr.write(`wasmer: Package '${name}' not found. Try 'wasmer list' first.\n`);
        return 1;
      }
      let buf;
      try {
        const { readFile } = await import("node:fs/promises");
        buf = await readFile(new URL(`../www/wasm-bin/${name}.wasm`, import.meta.url));
      } catch {
        ctx.stderr.write(`wasmer: ${name}.wasm not built — run the repo's build script (e.g. ./build-wasm-grep.sh)\n`);
        return 1;
      }
      const destPath = `/usr/bin/${name}.wasm`;
      await fs.writeBlob(destPath, new Blob([buf]));
      ctx.stdout.write(`Installed ${name} → ${destPath} (${buf.length} bytes)\n`);
      return 0;
    }
    ctx.stderr.write(`wasmer: unknown command '${args[0]}' (list, install, search, help)\n`);
    return 2;
  
  },

  async which(ctx, args) {
    // which cmd... — print the path (or builtin) the shell would run
    // for each command name, like POSIX `which`. Lookup is the same
    // as command resolution (wasm binary → builtin → .js/.mjs/.wasm
    // files in $PATH) but without the auto-download side effect.
    if (args.length === 0) {
      ctx.stderr.write("which: missing operand\n");
      return 2;
    }
    let missing = false;
    for (const name of args) {
      const resolved = await ctx.findCommand(name);
      if (!resolved) {
        missing = true;
        ctx.stderr.write(`which: no ${name} in (${env.PATH})\n`);
        continue;
      }
      if (resolved.type === "builtin") {
        ctx.stdout.write(`${name}: shell builtin\n`);
      } else if (resolved.type === "badpath") {
        ctx.stdout.write(`${resolved.path} (not executable: ${resolved.err})\n`);
      } else {
        ctx.stdout.write(resolved.path + "\n");
      }
    }
    return missing ? 1 : 0;
  
  },

  async whoami(ctx, args) {
    ctx.stdout.write((env.USER || "jtsh") + "\n");
    return 0;
  
  },

    async cmdExe(ctx, args) {

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
      ctx.stdout.write(`cmd.exe — run Windows batch by transpiling it to JS

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
          ctx.stderr.write("cmd.exe: -f needs a file name\n");
          return 2;
        }
        try {
          source = await fs.read(file);
        } catch (e) {
          ctx.stderr.write(`cmd.exe: ${file}: ${e.message}\n`);
          return 1;
        }
        argv0 = file;
        continue;
      }
      pos.push(a);
    }
    if (source === null) {
      if (pos.length === 0) {
        if (ctx.stdin) {
          source = ctx.stdin; // piped in
        } else if (args.length === 0 && ctx.isTTY) {
          // bare `cmd.exe` with no pipe → an interactive REPL
          ctx.enterRepl("cmd");
          return 0;
        } else {
          ctx.stderr.write("cmd.exe: no script given (pass one as an argument, /c CMD, -f FILE, or pipe it in)\n");
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
          ctx.stderr.write(`cmd.exe: ${file}: No such file or directory\n`);
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
        
        const { js } = await batToJS(fs, source);
        ctx.stdout.write(js);
        if (keepOpen) ctx.enterRepl("cmd");
        return 0;
      }
      
      const code = await runBat(fs, source, {
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        runCmd: ctx.runNestedCommand,
        args: scriptArgs,
        argv0,
      });
      if (keepOpen) ctx.enterRepl("cmd");
      return code;
    } catch (e) {
      if (e instanceof InterruptError) throw e;
      ctx.stderr.write(`cmd.exe: ${e.message}\n`);
      return 1;
    }
  }
};
