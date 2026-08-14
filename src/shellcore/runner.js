// ─── shellcore/runner.js — SHARED line/pipeline runners ───────────
// The conditional-list / pipeline / background-segment mechanics both
// shells duplicated (handleLine, runConditionalList, runPipeline and the
// split helpers were byte-identical except for the output writer and the
// browser's background-job `target`). Shared here; the per-shell bits
// (runSegment, runViaTranspiler, job launch, output writers) come from
// ctx: { stderr, write, getBgJobs, runViaTranspiler, runSegment }.
import { hasOption, setShellStatus, setLastBgPid } from "../env.js";
import { tokenize } from "./tokenize.js";
import { createSh2Runtime } from "../sh2runtime.js";

// Ctrl+C (SIGINT) — the shared command runners race a command against
// this so an abort returns status 130 (128 + SIGINT).
export class InterruptError extends Error {
  constructor() { super("interrupt"); this.name = "InterruptError"; }
}

export function splitBgList(line) {
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
      // `&` inside a redirection — `>&2`, `2>&1`, `&>file` — is NOT a
      // background marker (bash: `cmd >&2` runs in the FOREGROUND with
      // stdout dup'd to fd 2). Background `&` is a word boundary: its
      // previous char is a space/operator, never `>` (and `&>` starts
      // the redirect, so a following `>` also disqualifies it).
      const lastNonSpace = (() => { let c = null; for (let j = cur.length - 1; j >= 0; j--) { if (cur[j] !== " " && cur[j] !== "\t") { c = cur[j]; break; } } return c; })();
      if (lastNonSpace === ">" || line[i + 1] === ">") { cur += ch; continue; }
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

export function splitConditionals(line) {
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
      // a lone `&` is an error — UNLESS it's inside a redirect (`>&2`,
      // `2>&1`, `&>`), where the splitter must let it through
      const lastNonSpace = (() => { let c = null; for (let j = cur.length - 1; j >= 0; j--) { if (cur[j] !== " " && cur[j] !== "\t") { c = cur[j]; break; } } return c; })();
      if (!(lastNonSpace === ">" || line[i + 1] === ">")) {
        throw new Error("syntax error near unexpected token '&'");
      }
    }
    cur += ch;
  }
  parts.push({ text: cur, op });
  return parts;
}

export function splitPipe(line) {
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

export function looksLikeBash(text) {
  // strip ONLY single quotes — double quotes are not inert: ${…} /
  // $(…) inside them is real bash (`echo "${a[1]}"` must route to the
  // transpiler, while `echo 'a;b'` is one literal argument)
  const unquoted = String(text).replace(/'(?:[^'\\]|\\.)*'/g, "");
  // a leading `name=value` (no space before `=`) is an assignment, not a
  // command — bash always parses it that way (`a = 5` stays a command
  // named `a` because the tokenizer splits on whitespace)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted)) return true;
  if (/\b(for|while|until|if|case|select|function)\b/.test(unquoted)) return true;
  // `{a,b}` comma-brace expansion is NOT bash-only syntax — the native
  // tokenizer's brace+glob pass handles it (`ls {x,y}.c` should stay
  // native so the real ls runs, not the transpiler's sync-builtin stub).
  // The find -exec placeholder `{}` and its escaped terminator `\;` are
  // also native tokens, not bash control syntax — strip them so the
  // check only flags real `;` separators and `{ … }` command groups.
  const noBrace = unquoted.replace(/\{[^{}]*,[^{}]*\}/g, "").replace(/\{\}/g, "").replace(/\\;/g, "");
  if (/[;{}]/.test(noBrace)) return true;                 // `;` separator, `{ … }` group
  if (/\$\(|\[\[/.test(unquoted)) return true;          // $(…) / [[ ]]
  if (/\[[^\]]*\]/.test(unquoted)) return true;           // [ … ] test
  return /\$\{/.test(unquoted);
}

export async function handleLine(line, initialStdin, ctx, target = null) {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Split on `&` first — each `&`-terminated segment runs as a
  // background job, everything else runs in the foreground. Segments
  // themselves are conditional lists (`&&` / `||`) of pipelines.
  let segments;
  try {
    segments = splitBgList(trimmed);
  } catch (e) {
    ctx.stderr.write(`jtsh: ${e.message}\n`);
    return;
  }
  for (const seg of segments) {
    if (!seg.text.trim()) {
      ctx.stderr.write(`jtsh: syntax error near unexpected token '&'\n`);
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
        ctx.stderr.write(`jtsh: ${e.message}\n`);
        return;
      }
      const bad = cond.find((p) => !p.text.trim());
      if (bad) {
        const token = bad.op || "newline";
        ctx.stderr.write(`jtsh: syntax error near unexpected token '${token}'\n`);
        return;
      }
    }
  }

  let exitCode = 0;
  for (const seg of segments) {
    if (seg.bg) {
      const job = ctx.getBgJobs().launch(seg.text);
      setLastBgPid(job.pid);   // $! — last background job's pid
      ctx.write(`[${job.id}] ${job.pid}\n`);
    } else {
      exitCode = await runConditionalList(seg.text, initialStdin, ctx, target);
    }
  }
  return exitCode;
}

export async function runConditionalList(text, initialStdin, ctx, target = null) {
  let parts;
  try {
    parts = splitConditionals(text);
  } catch (e) {
    ctx.stderr.write(`jtsh: ${e.message}\n`);
    return 2;
  }
  // An empty segment means the segment started with an operator, ended
  // with one, or had two operators in a row (`&& echo hi`, `echo hi &&`,
  // `a && || b`) — all syntax errors.
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].text.trim()) {
      const nextOp = i + 1 < parts.length ? parts[i + 1].op : null;
      const token = nextOp ? `'${nextOp}'` : "newline";
      ctx.stderr.write(`jtsh: syntax error near unexpected token ${token}\n`);
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
    if (hasOption("x")) ctx.stderr.write(`+ ${parts[i].text}\n`);   // set -x
    if (looksLikeBash(parts[i].text)) {
      try {
        exitCode = await ctx.runViaTranspiler(parts[i].text, initialStdin);
      } catch (e) {
        // The library refused (outside its subset) or the shape needs the
        // sync bridge — fall back to the normal pipeline, which reports
        // the not-found / literal exactly as before.
        exitCode = await runPipeline(parts[i].text, initialStdin, ctx, target);
      }
      setShellStatus(exitCode);   // $? reflects every command, native or transpiled
      continue;
    }
    exitCode = await runPipeline(parts[i].text, initialStdin, ctx, target);
    setShellStatus(exitCode);
  }
  return exitCode;
}

export async function runPipeline(pipelineText, initialStdin, ctx, target = null) {
  const segments = splitPipe(pipelineText);
  let stdin = initialStdin;
  let exitCode = 0;
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].trim()) {
      ctx.stderr.write(`jtsh: syntax error near unexpected token '|'\n`);
      return 2;
    }
    const result = await ctx.runSegment(segments[i], stdin, i === segments.length - 1, target);
    if (!result.ok) return result.code ?? 1;
    stdin = result.output;
    exitCode = result.code ?? 0;
  }
  return exitCode;
}

// ─── pipe helpers — bytes/string conversion, capture joining ──────
export const pipeText = (d) => (typeof d === "string" ? d : new TextDecoder().decode(d));
export const pipeBytes = (d) => (typeof d === "string" ? new TextEncoder().encode(d) : d);
export const joinOut = (chunks) => {
  if (chunks.length === 0) return "";
  if (chunks.every((c) => typeof c === "string")) return chunks.join("");
  const parts = chunks.map(pipeBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ─── real coreutils (uutils wasm) ────────────────────────────────
// uutils.org's Rust coreutils compiled to wasm32-wasi. The multi-call
// uutils.wasm dispatches on argv[0], so a bare command this shell doesn't
// ship runs it with argv[0] = the command name. sed ships as its own
// single-call wasm. ctx: { readBin(name) → bytes (node: repo file;
// browser: fetch wasm-bin/) }.
let uutilsWasmPromise = null;

export const UUTILS_COMMANDS = new Set(["arch","b2sum","base32","base64","basename","basenc","cat","cksum","comm","cp","csplit","cut","date","dd","dir","dircolors","dirname","echo","expand","factor","fmt","fold","head","join","link","ln","ls","md5sum","mkdir","mktemp","mv","nl","nproc","numfmt","od","paste","pathchk","pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shred","shuf","sleep","sort","split","sum","tail","tee","touch","tr","truncate","tsort","tty","uname","unexpand","uniq","unlink","vdir","wc","sed"]);

export function ensureUutilsWasm(fs, readBin) {
  uutilsWasmPromise ??= (async () => {
    // stage wasm-bin/*.wasm into the VFS (browser auto-load does this
    // for WASM_BIN; node stages on demand from the repo copy)
    for (const name of ["uutils.wasm", "sed.wasm"]) {
      const path = "/usr/bin/" + name;
      const st = await fs.stat(path).catch(() => null);
      if (st) continue;
      const bytes = await readBin(name);
      await fs.writeBlob(path, new Blob([bytes]));
    }
    return "/usr/bin/uutils.wasm";
  })();
  return uutilsWasmPromise;
}

// runUutilsCommand — the multi-call coreutils execution block shared by
// both runSegments. Returns { result } when handled, null to fall
// through to the normal not-found path. ctx: { wasmRunner, writeOut,
//   stdout, stderr } (pipeText comes from this module).
export async function runUutilsCommand(cmd, args, stdin, { outputRedirect, appendRedirect, isLast }, ctx) {
  if (cmd.includes("/") || !UUTILS_COMMANDS.has(cmd)) return null;
  try {
    await ensureUutilsWasm(ctx.fs, ctx.readBin);
    const uuPath = cmd === "sed" ? "/usr/bin/sed.wasm" : "/usr/bin/uutils.wasm";
    await ctx.wasmRunner.run(uuPath, [cmd, ...args], stdin);
    const uuBytes = ctx.wasmRunner.getStdoutBytes();
    const uuErr = ctx.wasmRunner.getStderr();
    let output = "";
    if (outputRedirect) {
      await ctx.writeOut(outputRedirect, uuBytes.length ? uuBytes : "", appendRedirect);
    } else if (isLast) {
      if (uuBytes.length) ctx.stdout.write(pipeText(uuBytes));
    } else {
      output = uuBytes;
    }
    if (uuErr) ctx.stderr.write(uuErr);
    const uuCode = ctx.wasmRunner.getExitCode();
    if (uuCode !== 0) {
      ctx.stderr.write(`${cmd}: exited with code ${uuCode}\n`);
      return { result: { ok: false, code: uuCode, output: "" } };
    }
    return { result: { ok: true, code: 0, output } };
  } catch { return null; }   // fall through to the normal not-found path
}

export async function runSegment(segmentText, stdin, isLast, target, ctx) {
  let tokens;
  try {
    tokens = tokenize(segmentText);
    if (ctx.globExpand) tokens = await ctx.globExpand(tokens);   // ls *.png → matched paths
  } catch (e) {
    ctx.stderr.write(`jtsh: ${e.message}\n`);
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

  // ── fd redirections: `>&2`, `1>&2`, `2>&1`, `2>file`, `&>file` ──
  // The `&` here is a redirect, not background (splitBgList already
  // keeps it in the segment). Only fds 1 and 2 are real sinks in this
  // shell; route stdout/stderr to the fd or file target. `1>file` is the
  // existing `> file` handled below.
  let stdoutFd = null;      // >&2 / 1>&2  — stdout goes to stderr
  let stderrFd = null;      // 2>&1        — stderr goes to stdout
  let stderrTarget = null;  // 2>file / 2>>file
  let stderrAppend = false;
  let bothTarget = null;    // &>file / &>>file — stdout AND stderr → file
  let bothAppend = false;
  let stdoutTarget = null;  // 1>file — the explicit fd-1 form (plain `> file`
  let stdoutAppend = false; //          is handled by the existing logic below)
  const keptArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const fdLink = /^(\d*)>&(\d+)$/.exec(a);          // >&2, 1>&2, 2>&1
    const fdFile = /^([0-9]*|&)(>>?)([^>].*)$/.exec(a); // 2>file, 2>>file, 1>file, &>file (glued)
    if (fdLink) {
      const from = fdLink[1] ? Number(fdLink[1]) : 1;
      const to = Number(fdLink[2]);
      if (from === 1 && to === 2) stdoutFd = 2;
      else if (from === 2 && to === 1) stderrFd = 1;
      else ctx.stderr.write(`jtsh: ${a}: only 1>&2 and 2>&1 are supported here\n`);
      continue;
    }
    if (fdFile) {
      const from = fdFile[1] || "1";
      const op = fdFile[2];
      const target = fdFile[3];
      if (from === "&") { bothTarget = target; bothAppend = op === ">>"; }
      else if (from === "2") { stderrTarget = target; stderrAppend = op === ">>"; }
      else if (from === "1") { stdoutTarget = target; stdoutAppend = op === ">>"; }
      else ctx.stderr.write(`jtsh: ${a}: only fds 1 and 2 exist here\n`);
      continue;
    }
    if ((a === "&>" || a === "&>>" || a === "1>" || a === "1>>" || a === "2>" || a === "2>>") && i + 1 < args.length) {
      if (a.startsWith("&")) { bothTarget = args[i + 1]; bothAppend = a === "&>>"; }
      else if (a.startsWith("2")) { stderrTarget = args[i + 1]; stderrAppend = a === "2>>"; }
      else { stdoutTarget = args[i + 1]; stdoutAppend = a === "1>>"; }
      i++; // consume the target token
      continue;
    }
    keptArgs.push(a);
  }
  args.length = 0; args.push(...keptArgs);

  // Output router for THIS command only (guarded restore): background
  // jobs render into their panel slice (target), foreground commands go
  // to the terminal. Because it is installed per command, a job that
  // runs forever never captures the foreground's output, and nested
  // routers forward to their saved writer instead of recursing.
  // fd redirections reroute the streams: `>&2` sends stdout to the
  // stderr sink, `2>&1` stderr to stdout, `2>file`/`&>file` capture
  // stderr for a file flush in the finally.
  const preOut = ctx.stdout.write;
  const preErr = ctx.stderr.write;
  const effectiveOut = stdoutFd === 2 ? preErr : preOut;
  const effectiveErr = stderrFd === 1 ? preOut : preErr;
  const stderrToFile = bothTarget || stderrTarget;
  const stderrAppendTo = bothTarget ? bothAppend : stderrAppend;
  const errChunks = [];
  const routerOut = (chunk) => {
    if (ctx.stdout.write !== routerOut) return preOut(chunk);
    if (ctx.suppressOutput()) return true;
    if (target && target.appendOut) { target.appendOut(chunk); return true; }
    return effectiveOut(chunk);
  };
  // Transparent router: forwards to its saved writer. The __wraps link
  // lets nested captures (runNestedCommand) recognise they're still in
  // the active write chain while this router sits on top — without it,
  // the bash REPL's PRE/POST markers leak to the terminal instead of
  // reaching the capture buffer.
  routerOut.__wraps = preOut;
  const routerErr = (chunk) => {
    if (ctx.stderr.write !== routerErr) return preErr(chunk);
    if (ctx.suppressOutput()) return true;
    if (target && target.appendErr) { target.appendErr(chunk); return true; }
    if (stderrToFile) { errChunks.push(chunk); return true; }
    return effectiveErr(chunk);
  };
  routerErr.__wraps = preErr;
  ctx.stdout.write = routerOut;
  ctx.stderr.write = routerErr;
  const restoreWriters = () => {
    if (ctx.stdout.write === routerOut) ctx.stdout.write = preOut;
    if (ctx.stderr.write === routerErr) ctx.stderr.write = preErr;
  };
  try {

  let outputRedirect = null;
  let appendRedirect = false;
  // `&>file` — stdout AND stderr to the same file: the existing stdout
  // redirect mechanism handles the stdout side; stderr is captured by
  // the router and flushed in the finally. `1>file` (explicit fd-1) is
  // the same as `> file` — the fd-1 parse above may have set it.
  if (bothTarget) { outputRedirect = bothTarget; appendRedirect = bothAppend; }
  else if (stdoutTarget) { outputRedirect = stdoutTarget; appendRedirect = stdoutAppend; }
  let redirectIndex = args.indexOf(">>");
  if (redirectIndex === -1) redirectIndex = args.indexOf(">");
  else appendRedirect = true;
  if (redirectIndex !== -1 && !outputRedirect) {
    outputRedirect = args[redirectIndex + 1];
    args.splice(redirectIndex, 2);
  }

  // per-shell command intercepts (cc/cproc/tcc compilers etc.) — a
  // chance to handle a command before resolution
  if (ctx.interceptCommand) {
    const inter = await ctx.interceptCommand(cmd, args, stdin, isLast, { outputRedirect, appendRedirect });
    if (inter) return inter;
  }

  // python — MicroPython engine (reactor, src/py.js): REPL, -c, script
  // files and stdin. Intercepted before resolveCommand so it never
  // auto-loads python.wasm or needs a worker/SAB.
  if (cmd === "python" && !cmd.includes("/")) {
    return await ctx.runPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect);
  }
  // perl — bare `perl` with no script/stdin opens the interactive REPL
  // (the /bin perl command handles -e / script / stdin as before).
  if (cmd === "perl" && !cmd.includes("/") && args.length === 0 && !pipeText(stdin).trim()) {
    ctx.enterPerlRepl();
    return { ok: true, code: 0, output: "" };
  }
  // /bin/bash — the REAL bash 5.3 (wasm32-emscripten), unlike the bare
  // `bash` builtin which transpiles bash → JS. Runs -c / a VFS script /
  // stdin through the actual bash binary.
  if (cmd === "/bin/bash") {
    try {
      const runRealBash = ctx.runRealBash;
      const hostRun = async (cmdline, stdinIn, bashCwd) => {
        // NB: the output is NOT written here — runRealBash appends it to
        // bash's own stdout so the transcript stays in execution order.
        const h = await ctx.runNestedCommand(cmdline, stdinIn || "");
        return h;
      };
      let script = "";
      if (args[0] === "-c") script = args.slice(1).join(" ");
      else if (args.length && !args[0].startsWith("-")) {
        try { script = await ctx.fs.read(args[0]); } catch { script = args[0]; }
      } else if (stdin) script = pipeText(stdin);
      if (!script.trim()) {
        ctx.stderr.write("/bin/bash: the real bash 5.3 — give it a script: /bin/bash -c 'echo hi' · /bin/bash script.sh · cat x | /bin/bash — sees /tmp and /home (writes sync back). Top-level external commands run synchronously in the shell (correct order, $? and stdin redirects); pipelines/subshells still need a real fork — those fail. `web <cmd>` also runs in the shell. Bare `bash` is the interactive builtin\n");
        return { ok: false, code: 2, output: "" };
      }
      const r = await runRealBash(script, { hostRun });
      if (outputRedirect) await ctx.writeOut(outputRedirect, r.out, appendRedirect);
      else if (isLast) { if (r.out) ctx.stdout.write(r.out); }
      else output = r.out;
      if (r.err) ctx.stderr.write(r.err);
      return { ok: r.code === 0, code: r.code, output: r.out };
    } catch (e) {
      ctx.stderr.write("/bin/bash: " + (e && e.message ? e.message : e) + "\n");
      return { ok: false, code: 1, output: "" };
    }
  }

  let output = "";

  const resolved = await ctx.resolveCommand(cmd);
  if (resolved && resolved.type === "badpath") {
    // The path exists but can't be executed (a directory, or not a
    // .js/.mjs/.wasm file) — exit 126, POSIX "found but not executable".
    ctx.stderr.write(`${cmd}: ${resolved.err}\n`);
    return { ok: false, code: 126, output: "" };
  }
  if (!resolved) {
    // Real coreutils (uutils wasm): a bare command this shell doesn't
    // ship natively runs the multi-call uutils.wasm with argv[0] = the
    // command name (printf, sed, tr, cut, seq, sort, uniq, …).
    if (!cmd.includes("/") && UUTILS_COMMANDS.has(cmd)) {
      const uu = await runUutilsCommand(cmd, args, stdin, { outputRedirect, appendRedirect, isLast },
        { fs: ctx.fs, readBin: ctx.readBin, wasmRunner: ctx.wasmRunner, writeOut: ctx.writeOut, stdout: ctx.stdout, stderr: ctx.stderr });
      if (uu) return uu.result;
    }
    const hints = {
      "nano": "edit", "emacs": "edit",
      "more": "cat", "less": "cat",
      "cls": "clear", "quit": "exit", "q": "exit",
      "?": "help", "dir": "ls", "ll": "ls", "la": "ls",
      "chdir": "cd",
      "apt": "wasmer", "apt-get": "wasmer", "yum": "wasmer",
      "dnf": "wasmer", "brew": "wasmer", "pacman": "wasmer",
      "apk": "wasmer", "pip": "wasmer", "npm": "wasmer install",
      "sh": "bash",
    };
    const hint = hints[cmd];
    if (hint) {
      ctx.stderr.write(`${cmd}: command not found — try "${hint}" instead\n`);
    } else {
      ctx.stderr.write(`${cmd}: command not found\n`);
    }
    return { ok: false, code: 127, output: "" };
  }

  // Make pipe input available to builtins (head etc.) — text form.
  // Binary consumers (wasm programs, gzip, cat) get the raw `stdin`.
  ctx.stdinBuffer = pipeText(stdin);
  ctx.rawStdin = stdin;

  try {
    if (resolved.type === "sh") {
      // .sh script or a #!-shebang file. bash/sh (and the shell's own
      // `sh2perl` identity) → run through the bash transpiler; any
      // other interpreter is re-dispatched as
      // `<interp> <script> <args>` through the normal command machinery.
      let interp = "bash";
      if (resolved.shebang) {
        const words = resolved.shebang.split(/\s+/);
        interp = words[words.length - 1].split("/").pop();
        if (interp.startsWith("-")) interp = "bash";   // `#!/bin/sh -e` style
      }
      if (interp !== "bash" && interp !== "sh" && interp !== "dash" && interp !== "ash" && interp !== "ksh" && interp !== "sh2perl") {
        const q = (w) => "'" + String(w).replace(/'/g, "'\\''") + "'";
        const quoted = [interp, q(resolved.path), ...args.map((a) => q(a))].join(" ");
        return await runSegment(quoted, stdin, isLast, target, ctx);
      }
      let content;
      try {
        content = await ctx.fs.read(resolved.path);
      } catch (e) {
        ctx.stderr.write(`${cmd}: ${e.message}\n`);
        return { ok: false, code: 1, output: "" };
      }
      // Capture output for pipes/redirects, like the builtin branch.
      const origWrite = ctx.stdout.write;
      const chunks = [];
      const capture = outputRedirect || !isLast;
      let captureFn = null;
      if (capture) {
        const preCapture = ctx.stdout.write;
        captureFn = (chunk) => {
          if (ctx.stdout.write === captureFn) { chunks.push(chunk); return true; }
          return preCapture.call(stdout, chunk);
        };
        ctx.stdout.write = captureFn;
      }
      let code = 1;
      try {
        // The .sh command path: runBash (the debashcl engine — the SAME
        // pipeline as `bash script.sh`) handles the full bash surface;
        // fall back to the shared otranspilerl runShellScript when the
        // ctx doesn't provide it.
        if (typeof ctx.runBashScript === "function") {
          code = await ctx.runBashScript(content, { args, argv0: cmd });
        } else {
          code = await ctx.runShellScript(content, { args, argv0: cmd, runCmd: ctx.runNestedCommand });
        }
      } catch (e) {
        ctx.stderr.write(`${cmd}: ${e.message}\n`);
      } finally {
        if (capture) {
          if (ctx.stdout.write === captureFn) ctx.stdout.write = origWrite;
          const captured = joinOut(chunks);
          if (outputRedirect) await ctx.writeOut(outputRedirect, captured, appendRedirect);
          else output = captured;
        }
      }
      return { ok: code === 0, code, output };
    }
    if (resolved.type === "wasm") {
      try {
        


        // Go js/wasm binaries (`go build` output, or anything compiled with
        // GOOS=js GOARCH=wasm) run through the Go runner (wasm_exec.js +
        // VirtualFS fs shim), not the WASI runner.
        if (await ctx.goRunner.isGoModule(resolved.path)) {
          const gr = await ctx.goRunner.runModule(resolved.path, [cmd, ...args], stdin);
          if (gr.stdout) ctx.write(gr.stdout);
          if (gr.stderr) ctx.write(gr.stderr, "err");
          if (gr.code !== 0) {
            ctx.write(`${cmd}: exited with code ${gr.code}\n`, "err");
            return { ok: false, code: gr.code, output: "" };
          }
          return { ok: true, code: 0, output: gr.stdout };
        }

        // Run a wasm32-wasi binary (full WASI via @wasmer/wasi, filesystem
        // bridged to our VirtualFS via @wasmer/wasmfs)
        let wasmArgs = [cmd, ...args];
        await ctx.wasmRunner.run(resolved.path, wasmArgs, stdin);
        const exitCode = ctx.wasmRunner.getExitCode();
        let wasmOut = ctx.wasmRunner.getStdout();        // text (program output)
        let wasmBytes = ctx.wasmRunner.getStdoutBytes(); // raw bytes — what the pipe carries
        const wasmErr = ctx.wasmRunner.getStderr();

        if (outputRedirect) {
          await ctx.writeOut(outputRedirect, wasmBytes.length ? wasmBytes : "", appendRedirect);
        } else if (isLast) {
          if (wasmOut) ctx.stdout.write(wasmOut);
        } else {
          output = wasmBytes;
        }
        if (wasmErr) {
          ctx.stderr.write(wasmErr);
        }
        if (exitCode !== 0) {
          ctx.stderr.write(`${cmd}: exited with code ${exitCode}\n`);
          return { ok: false, code: exitCode, output: "" };
        }
        return { ok: true, code: 0, output };
      } catch (e) {
        if (e instanceof InterruptError) throw e;
        ctx.stderr.write(`${cmd}: wasm error: ${e.message}\n`);
        return { ok: false, code: 1, output: "" };
      }
    }

    if (resolved.type === "builtin") {
      const origWrite = ctx.stdout.write;
      const chunks = [];
      const capture = outputRedirect || !isLast;
      let captureFn = null;
      if (capture) {
        // Guarded capture: only swallow output while THIS command is the
        // current writer. If a background job has swapped the writer
        // meanwhile, forward to the pre-capture writer instead —
        // concurrent output must never be swallowed into someone
        // else's redirect.
        const preCapture = ctx.stdout.write;
        captureFn = (chunk) => {
          if (ctx.stdout.write === captureFn) { chunks.push(chunk); return true; }
          return preCapture(chunk);
        };
        ctx.stdout.write = captureFn;
      }
      let code = 0;
      try {
        ctx.builtinCapture = capture;
        code = (await resolved.fn(args)) ?? 0;
      } finally {
        if (capture) {
          if (ctx.stdout.write === captureFn) ctx.stdout.write = origWrite;
          const captured = joinOut(chunks);
          if (outputRedirect) await ctx.writeOut(outputRedirect, captured, appendRedirect);
          else output = captured;
        }
      }
      return { ok: code === 0, code, output };
    }

    // Run a .js command file from /commands/ (or /bin/, /usr/bin/)
    const content = await ctx.fs.read(resolved.path);
    // `pipe` (10th arg) gives command files the raw pipe: `pipe.in` is
    // the previous segment's stdout (string or Uint8Array — the 4th
    // `stdin` arg is its text form), and `pipe.out(data)` captures
    // output into the pipe (strings or raw bytes; gzip emits bytes).
    const fn = new Function("args", "fs", "console", "stdin", "env", "process", "sh2", "sh2lib", "shell", "qbe2wasm", "pipe", `
        return (async () => { ${content} })();
      `);
    const logChunks = [];
    const fakeConsole = { log: (...msgs) => logChunks.push(msgs.join(" ") + "\n") };
    // `sh2` — the bash runtime (saved bash2js output calls sh2.exec & co.)
    const sh2rt = createSh2Runtime({
      fs: ctx.fs, env: ctx.env,
      shellExec: ctx.runNestedCommand,
      stdout: ctx.stdout, stderr: ctx.stderr,
      args: args.slice(1),
      argv0: cmd,
    });
    // `shell` — lets commands run lines through the shell itself (the
    // floating xterm terminal uses this); returns { out, err, code }.
    const shellApi = {
      runLine: (cmdLine) => ctx.runNestedCommand(cmdLine),
      jobs: ctx.getJobScheduler(),   // at/cron scheduler (src/jobs.js)
      // When the command runs as a background job, its output lands in
      // the job's panel slice; direct-DOM commands (watch) render there.
      outputTarget: target,
      // Register a callback fired on Ctrl+C — lets long-running commands
      // (watch, xeyes, ...) tear themselves down when interrupted.
      onInterrupt: (fn) => { ctx.onInterrupt(fn); },
      // Register a callback fired on printable keys (and Enter/Backspace)
      // while the command runs — lets interactive commands (typist) read
      // the keyboard. Return true to consume the key.
      onKey: (fn) => { ctx.keyCallbacks.push(fn); },
    };
    const pipe = {
      in: stdin,          // raw pipe input (string or Uint8Array)
      out: (data) => logChunks.push(data),  // capture into the pipe
    };
    // `process` for command files: prefer the persistent runtime's shim
    // (otProc has env; the browser's global process is go.js's env-less
    // shim; node's global has everything).
    const fileProc = (ctx.otProc() && ctx.otProc().env)
      ? ctx.otProc()
      : (typeof process !== "undefined" && process && process.env ? process : { env: ctx.env || {} });
    const keyCbsBefore = ctx.keyCallbacks.length;
    const intrCbsBefore = ctx.interruptCallbacks.length;
    let ret;
    try {
      ret = await fn(args, ctx.fs, fakeConsole, pipeText(stdin), ctx.env, fileProc, sh2rt.sh2, ctx.sh2libFacade, shellApi, ctx.qbe2wasm, pipe);
    } finally {
      // Commands may register key/interrupt callbacks (typist, watch,
      // ...). Once the command finishes — normally or via Ctrl+C — the
      // shell owns the keyboard again: drop whatever it left registered
      // so a stale callback can never swallow typing or Tab completion.
      ctx.keyCallbacks.length = keyCbsBefore;
      ctx.interruptCallbacks.length = intrCbsBefore;
    }
    // A command file may return a number to set its exit status
    const code = typeof ret === "number" ? ret : 0;
    output = joinOut(logChunks);
    if (outputRedirect) {
      await ctx.writeOut(outputRedirect, output);
      output = "";
    } else if (isLast) {
      if (output) ctx.stdout.write(pipeText(output));
      output = "";
    }
    return { ok: code === 0, code, output };
  } catch (e) {
    if (e instanceof InterruptError) throw e;
    // A leftover /bin file shadowing a SOURCED function (bash: functions
    // beat files). If the file failed but the name is a sourced function,
    // dispatch through the persistent runtime instead.
    if (ctx.getOtRt && ctx.getOtRt() && ctx.getOtRt().sh2 && ctx.getOtRt().sh2.functions && ctx.getOtRt().sh2.functions.has(cmd)) {
      try {
        const v = await ctx.getOtRt().sh2.fnCall(cmd, args);
        syncOtVarsFromStore(ctx.getOtRt(), ctx.getOtVars());
        ctx.procfs.finish(pid, 0);
        return { ok: true, code: 0, output: "" };
      } catch {}
    }
    ctx.stderr.write(`${cmd}: error: ${e.message} (${resolved.path})\n${e.stack}\n`);
    return { ok: false, code: 1, output: "" };
  }
  } finally {
    restoreWriters();
    // flush a `2>file` / `&>file` stderr capture (the routers collected
    // the chunks while the command ran)
    if (stderrToFile && errChunks.length) {
      await ctx.writeOut(stderrToFile, joinOut(errChunks), stderrAppendTo);
    }
  }
}

// Split a line into background segments on a single `&` (respecting
// quotes and backslash escapes). `&&` is the conditional operator and
// stays inside a segment (handled by splitConditionals later). Returns
// { text, bg } parts: bg=true when the segment was terminated by `&`,
// meaning it runs as a background job (`cmd & cmd2` → cmd bg, cmd2 fg).


// ─── otranspilerl fallback: bash concepts jtsh's parser doesn't know ──
// Lines carrying bash-only syntax (statement separators (`;`), the
// for/while/if/case keywords, `$(…)` command substitution, `[[ ]]`) —
// route through the unified otranspilerl library (the real debashl core
// + estree backend): sh → A1 shIR → ESTree → JS, executed with the sh2.*
// runtime. `x=5; echo $x`, `for i in …; do …; done`, `if …; then …; fi`
// and friends just work; constructs needing the sync bridge (command
// substitution, pipelines, redirection) refuse loudly with a pointer to
// `bash`.
// The sh2 runtime + process shim are created ONCE and shared by every
// call, so state (functions, sh2.lastExit, cwd via fs) survives across
// lines. NB: plain shell variables (x=5) are emitted as bare JS

// ─── runPythonCmd: run a Python script through the shared MicroPython ──
// engine (src/py.js). SHARED by both shells — the only per-shell bits are
// the TTY check, the REPL entry and the output writers (ctx).
export async function runPythonCmd(args, stdin, isLast, outputRedirect, appendRedirect, ctx) {
  if (args.length === 0) {
    if (pipeText(stdin).trim()) {
      args = ["-"];
    } else if (typeof ctx.isTTY === "function" ? ctx.isTTY() : ctx.isTTY) {
      ctx.enterPythonRepl();
      return { ok: true, code: 0, output: "" };
    } else {
      ctx.stderr.write("python: no script given (python -c CODE | script.py | - for stdin)\n");
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
      source = await ctx.fs.read(args[0]);
    } catch (e) {
      ctx.stderr.write(`python: ${args[0]}: ${e.message}\n`);
      return { ok: false, code: 1, output: "" };
    }
  } else {
    ctx.stderr.write(`python: unknown option ${args[0]}\n`);
    return { ok: false, code: 2, output: "" };
  }
  if (source === null) {
    ctx.stderr.write("python: no script given (python -c CODE | script.py | - for stdin)\n");
    return { ok: false, code: 2, output: "" };
  }
  const { pyExec } = await import("../py.js");
  let output = "";
  const origWrite = ctx.stdout.write;
  ctx.stdout.write = (s) => { output += s; return true; };
  let code;
  try {
    code = await pyExec(source, { stdout: ctx.stdout, stderr: ctx.stderr });
  } catch (e) {
    ctx.stderr.write(`python: ${e.message}\n`);
    code = 1;
  } finally {
    ctx.stdout.write = origWrite;
  }
  if (outputRedirect) {
    await ctx.writeOut(outputRedirect, output, appendRedirect);
    output = "";
  } else if (isLast) {
    if (output) ctx.stdout.write(output);
  }
  return { ok: code === 0, code, output };
}
