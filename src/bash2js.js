// ─── bash2js: bash → JavaScript, transpiled in the browser ─────
//
// The full bash → JS pipeline runs entirely in the browser:
//
//   bash ──sh2perl.wasm──▶ Perl ──perl2js──▶ JavaScript
//
// 1. sh2perl (gmatht/debashc, compiled to wasm32-wasip1 — see
//    build-wasm-sh2perl.sh) parses bash and generates Perl. It runs
//    as a native WASI command through the same WasmRunner the shell
//    uses for every /bin/*.wasm binary.
// 2. perl2js (src/perl2js.js) transforms that machine-generated
//    Perl into statement-level JavaScript against the `rt` runtime
//    below and the shell's `env` object.
//
// Usage in tinysh:
//   bash2js 'echo hello world'     → prints the generated JS
//   bash2js -f script.sh           → transpile a file from the VFS
//   cat script.sh | bash2js        → transpile from a pipe
// -----------------------------------------------------------------

import { WasmRunner } from "./wasm.js";
import { perlToJS } from "./perl2js.js";
import { env } from "./env.js";

const BANNER_RE = /^Converting to Perl:\n=+\n([\s\S]*?)\n=+\n$/;

// ─── runtime preamble ───────────────────────────────────────────
// The generated JS is written against this `rt` object. In the shell
// it is available because bash2js emits this preamble; the browser
// shell also exposes the same helpers so generated files run as
// .js commands. `env` is the shell's shared environment singleton.
export function buildRuntimePreamble() {
  return `// ── runtime for generated JS (rt) ──────────────────────
const rt = {
  print: (...a) => {
    const s = a.join("");
    if (typeof stdout !== "undefined" && stdout.write) stdout.write(s);
    else if (typeof process !== "undefined" && process.stdout) process.stdout.write(s);
    else if (typeof console !== "undefined") console.log(s.replace(/\\n$/, ""));
  },
  concat: (a, b) => String(a) + String(b),
  add: (a, b) => Number(a) + Number(b),
  numeq: (a, b) => Number(a) === Number(b),
  streq: (a, b) => String(a) === String(b),
  chomp: (s) => String(s).replace(/\\n$/, ""),
  range: (a, b) => {
    const out = [];
    for (let i = Number(a); i <= Number(b); i++) out.push(i);
    return out;
  },
  join: (sep, ...lists) => lists.flat(1).map((x) => String(x)).join(String(sep)),
  split: (s) => Array.isArray(s) ? s : String(s).trim().split(/\\s+/),
  match: (s, re) => re.test(String(s)),
  whoami: () => (typeof env !== "undefined" && env.USER) || "tinysh",
  errstr: () => "(browser shell)",
  warn: (...a) => rt.print(...a),
  sleep: (s) => new Promise((r) => setTimeout(r, Number(s) * 1000)),
  test: async (op, path) => {
    try {
      if (op === "-z") return String(path).length === 0;
      if (op === "-n") return String(path).length > 0;
      if (typeof fs === "undefined") return op === "-e";
      const st = await fs.stat(path);
      if (op === "-e") return true;
      if (op === "-f") return st.type === "file";
      if (op === "-d") return st.type === "dir";
      if (op === "-s") return (st.size || 0) > 0;
      return true; // -x -r -w -L: assume readable
    } catch { return false; }
  },
  readFile: async (path) => {
    if (typeof fs === "undefined") throw new Error("rt.readFile: no filesystem");
    return await fs.read(path);
  },
  writeFile: async (path, data) => {
    if (typeof fs === "undefined") throw new Error("rt.writeFile: no filesystem");
    return await fs.write(path, data);
  },
  openWrite: async (path) => ({ buf: "", write(s) { this.buf += String(s); }, close() { return rt.writeFile(path, this.buf); } }),
  openAppend: async (path) => {
    let existing = "";
    try { existing = await fs.read(path); } catch {}
    return { buf: existing, write(s) { this.buf += String(s); }, close() { return rt.writeFile(path, this.buf); } };
  },
  exec: async (cmd) => {
    if (typeof __runCmd === "function") return await __runCmd(cmd);
    throw new Error("rt.exec: shell not available in this context: " + cmd);
  },
  system: async (...cmd) => { await rt.exec(cmd.join(" ")); return 0; },
  printf: (fmt, ...args) => rt.print(sprintf(fmt, ...args)),
  todo: (what) => { throw new Error("perl2js: unsupported construct: " + what); },
};
const sprintf = (fmt, ...args) => {
  let i = 0;
  return String(fmt).replace(/%[-+ 0]*\\d*(?:\\.\\d+)?[dsf%]/g, (m) => {
    if (m === "%%") return "%";
    const v = args[i++];
    if (m.endsWith("d")) return String(Math.trunc(Number(v)));
    if (m.endsWith("s")) return String(v);
    return String(Number(v));
  });
};
`;
}

function escapeJsComment(text) {
  return text.split("\n").map((l) => "//   " + l).join("\n");
}

// Ensure /bin/sh2perl.wasm exists. The CLI reads the prebuilt binary
// straight from the repo; the browser fetches it from the server.
async function ensureSh2perl(fs) {
  try {
    await fs.stat("/bin/sh2perl.wasm");
    return;
  } catch {
    // not installed yet
  }
  let buf = null;
  try {
    const resp = await fetch("wasm-bin/sh2perl.wasm");
    if (resp.ok) buf = await resp.arrayBuffer();
  } catch {
    // Node CLI: fall back to the repo file on disk
  }
  if (!buf) {
    try {
      const { readFile } = await import("node:fs/promises");
      buf = await readFile(new URL("../www/wasm-bin/sh2perl.wasm", import.meta.url));
    } catch {
      throw new Error("sh2perl.wasm not found — run ./build-wasm-sh2perl.sh or serve www/wasm-bin/");
    }
  }
  await fs.writeBlob("/bin/sh2perl.wasm", new Blob([buf]));
}

// ─── bashToJS: the one-call entry point ─────────────────────────
// Returns { js, perl }: the generated JavaScript (runtime preamble +
// transpiled statements) and the intermediate Perl.
export async function bashToJS(fs, bashSource, { wasmRunner } = {}) {
  const runner = wasmRunner || new WasmRunner(fs);
  await ensureSh2perl(fs);
  await runner.run("/bin/sh2perl.wasm", ["sh2perl", "parse", "--perl", bashSource]);
  const stdout = runner.getStdout();
  const m = BANNER_RE.exec(stdout);
  const perl = m ? m[1] : stdout;

  const header =
    "// ── Generated by bash2js ────────────────────────────────────\n" +
    "// bash → Perl (sh2perl.wasm) → JS (perl2js) — runs in the browser shell\n" +
    "// bash source:\n" +
    escapeJsComment(bashSource) + "\n";
  const js = header + buildRuntimePreamble() + "// ── transpiled statements ─────────────────────────────\n" + perlToJS(perl);
  return { js, perl };
}

// ─── runBash: transpile AND execute in one call ────────────────
// The "type bash, get generated JS executed" entry point: transpiles
// the source with bashToJS and runs the generated JS in a shell
// context where `fs`, `env`, `stdout` and `__runCmd` (the shell's
// own command runner — used for pipelines and command substitution)
// are in scope. Returns the script's exit code.
//
// The generated JS is wrapped in an async IIFE, so loops, sleeps and
// await-requiring helpers (rt.test, rt.exec, ...) all work, and the
// script's exit status (bash `exit N` / the implicit 0) comes back
// as the return value.
export async function runBash(fs, source, { wasmRunner, stdout, runCmd } = {}) {
  const { js } = await bashToJS(fs, source, { wasmRunner });
  const fn = new Function("args", "fs", "env", "stdout", "stdin", "__runCmd", `
    return (async () => {
      ${js}
    })();
  `);
  const code = await fn([], fs, env, stdout, "", runCmd);
  return typeof code === "number" ? code : 0;
}
