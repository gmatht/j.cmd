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
import { getSh2Lib } from "./sh2lib.js";
import { estreeToJs } from "./estree.js";

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
    // Returns { out, code }: the captured stdout and exit status of
    // running cmd through the shell's own pipeline machinery (so
    // pipelines, && and command substitution all nest correctly).
    if (typeof __runCmd === "function") return await __runCmd(cmd);
    throw new Error("rt.exec: shell not available in this context: " + cmd);
  },
  system: async (...cmd) => { await rt.exec(cmd.join(" ")); return 0; },
  // Run a pipeline (a | b) captured in a do{} block: execute it, put
  // its exit status in CHILD_ERROR (where the transpiled $CHILD_ERROR
  // references read it) and return the chomped stdout as the block's
  // value, e.g. for my $output_0 = do { ... }.
  pipe: async (cmd) => {
    const r = await rt.exec(cmd);
    if (typeof CHILD_ERROR !== "undefined") CHILD_ERROR = r.code;
    return rt.chomp(r.out);
  },
  // A pipeline used as an if/while/until condition: same execution,
  // but print the captured stdout (bash inherits the pipeline's
  // output) and return the exit STATUS — or status === 0 when the
  // generated Perl ends with $CHILD_ERROR == 0 — as the condition
  // value. 0 (success) is falsy, so if (!do { ... }) enters on
  // success and while (do { ... }) loops on success.
  pipeCond: async (cmd, asBool) => {
    const r = await rt.exec(cmd);
    if (typeof CHILD_ERROR !== "undefined") CHILD_ERROR = r.code;
    if (r.out) rt.print(r.out);
    return asBool ? r.code === 0 : r.code;
  },
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
    await fs.stat("/usr/bin/sh2perl.wasm");
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
  await fs.writeBlob("/usr/bin/sh2perl.wasm", new Blob([buf]));
}

// ─── bashToJS: the one-call entry point ─────────────────────────
// Returns { js, perl }: the generated JavaScript (runtime preamble +
// transpiled statements) and the intermediate Perl.
//
// Two paths: the ESTree path (debashcl.wasm — the unified debashc CLI
// reactor that replaced debashl.wasm/debashc.wasm — → sh2.* runtime,
// the "full bash" one) and the Perl path (sh2perl.wasm → perl2js).
// ESTree is preferred; if debashcl.wasm isn't available we fall back to
// Perl.
export async function bashToJS(fs, bashSource, { wasmRunner } = {}) {
  try {
    return await bashToJsEstree(fs, bashSource);
  } catch (eEstree) {
    try {
      return await bashToJsPerl(fs, bashSource, { wasmRunner });
    } catch (ePerl) {
      throw new Error(`${eEstree.message} · (Perl fallback also failed: ${ePerl.message})`);
    }
  }
}

// ─── ESTree path: bash → ESTree (debashcl.wasm) → JS ───────────
export async function bashToJsEstree(fs, bashSource) {
  const lib = await getSh2Lib();
  const ast = await lib.toEstree(bashSource);
  const js =
    "// ── Generated by bash2js (debashl ESTree path) ────────────────\n" +
    "// bash → ESTree → JS against the sh2.* runtime — full bash support\n" +
    "// bash source:\n" +
    escapeJsComment(bashSource) + "\n" +
    "// ── transpiled statements ─────────────────────────────\n" +
    estreeToJs(ast);
  return { js, perl: null, ast };
}

async function bashToJsPerl(fs, bashSource, { wasmRunner } = {}) {
  const runner = wasmRunner || new WasmRunner(fs);
  await ensureSh2perl(fs);
  await runner.run("/usr/bin/sh2perl.wasm", ["sh2perl", "parse", "--perl", bashSource]);
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

// ─── sh2lib facade: handed to .js commands as the `sh2lib` param ─
// Lets /bin/sh2js.js, /bin/sh2perl.js, /bin/debashc.js (and any user
// command) drive the debashl toolchain directly, in both shells.
export function buildSh2LibFacade(fs) {
  return {
    toEstree: (src) => getSh2Lib().then((l) => l.toEstree(src)),
    toPerl: (src) => getSh2Lib().then((l) => l.toPerl(src)),
    lex: (src) => getSh2Lib().then((l) => l.lex(src)),
    version: () => getSh2Lib().then((l) => l.version()),
    bashToJs: async (src) => (await bashToJsEstree(fs, src)).js,
  };
}

// ─── runBash: transpile AND execute in one call ────────────────
// The "type bash, get generated JS executed" entry point: transpiles
// the source with bashToJS and runs the generated JS in a shell
// context where `fs`, `env`, `stdout`, `stderr` and `__runCmd` (the
// shell's own command runner — used for pipelines, redirection and
// command substitution) are in scope. Returns the script's exit code.
//
// When the ESTree path was used, the generated JS is run with the
// `sh2.*` runtime (createSh2Runtime) in scope; the Perl path gets the
// `rt` runtime instead. `scriptArgs` become $1..$9/$@/$#.
export async function runBash(fs, source, { wasmRunner, stdout, stderr, runCmd, args = [], argv0 = "bash" } = {}) {
  const { js, ast } = await bashToJS(fs, source, { wasmRunner });
  const out = stdout || { write: () => {} };
  const err = stderr || { write: (s) => out.write(s) };
  if (ast) {
    // ESTree path: sh2.* runtime in scope.
    const { createSh2Runtime } = await import("./sh2runtime.js");
    const rt = createSh2Runtime({ fs, env, shellExec: runCmd, stdout: out, stderr: err, args, argv0 });
    const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", `
      return (async () => {
        ${js}
      })();
    `);
    const code = await fn([], fs, env, out, err, runCmd, rt.sh2);
    return typeof code === "number" ? code : 0;
  }
  const fn = new Function("args", "fs", "env", "stdout", "stdin", "__runCmd", `
    return (async () => {
      ${js}
    })();
  `);
  const code = await fn([], fs, env, out, "", runCmd);
  return typeof code === "number" ? code : 0;
}
