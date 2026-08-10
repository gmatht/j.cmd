// ─── shellcore/runner.js — SHARED line/pipeline runners ───────────
// The conditional-list / pipeline / background-segment mechanics both
// shells duplicated (handleLine, runConditionalList, runPipeline and the
// split helpers were byte-identical except for the output writer and the
// browser's background-job `target`). Shared here; the per-shell bits
// (runSegment, runViaTranspiler, job launch, output writers) come from
// ctx: { stderr, write, getBgJobs, runViaTranspiler, runSegment }.
import { hasOption, setShellStatus, setLastBgPid } from "../env.js";

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
      throw new Error("syntax error near unexpected token '&'");
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
  if (/[;{}]/.test(unquoted)) return true;                 // `;` separator, `{ … }` group
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
