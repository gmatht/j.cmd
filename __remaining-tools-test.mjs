// ─── __remaining-tools-test.mjs — the docs/remaining-tools.md batch ──
// Covers the shell-command batch (env/id/yes/xxd/stat/du/df/hostname/
// xargs), the debashcl idiom lifts ($(seq …), wc -l/-w/-c FILE, grep -q,
// test -f X && cat X), and the wasm-binary installs (awk/bzip2/xz).
// Run: node __remaining-tools-test.mjs
import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { createShellCore } from "./src/shellcore/index.js";
import { resolveCommand } from "./src/shellcore/resolve.js";
import { UUTILS_COMMANDS } from "./src/shellcore/runner.js";

let failures = 0;
const check = (label, got, want) => {
  const ok = String(got).trim() === String(want).trim();
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got:  ${JSON.stringify(String(got).trim())}\n      want: ${JSON.stringify(String(want).trim())}`}`);
};

// ── a minimal shell ctx (like the CLI's) for the builtins ──────
const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const runNestedCommand = async (cmdLine) => {
  // parse a possibly-quoted argv (xargs quotes each arg: 'echo' 'a')
  const argv = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmdLine)) !== null) argv.push(m[1] ?? m[2] ?? m[3]);
  if (argv[0] === "echo") { const out = argv.slice(1).join(" ") + "\n"; stdout.write(out); return { out, err: "", code: 0 }; }
  return { out: "", err: "", code: 0 };
};
const shellCtx = {
  stdout, stderr,
  get stdin() { return stdinBuf; },
  isTTY: false,
  fs,
  runNestedCommand,
  findCommand: (name) => resolveCommand(shellCtx, name),
  resolveCommand: (name) => resolveCommand(shellCtx, name),
  get builtins() { return bound; },
  autoLoad: async () => null,
  ensureOtRuntime: async () => null,
  get otRt() { return null; },
  runSourceContent: async () => 0,
  runBashScript: async () => 0,
  runJsSourceContent: async () => 0,
  getOtVars: () => new Map(),
  goRunner: null,
  fetchBusyboxBytes: async () => new Uint8Array(0),
  evalProgram: async () => 0,
  stdinBuffer: () => stdinBuf,
  otProc: () => null,
  stdoutWrite: (s) => stdout.write(s),
  stderrWrite: (s) => stderr.write(s),
  setOtRt: () => {},
  setOtProc: () => {},
  globExpand: async (t) => t,
  interceptCommand: async () => null,
  suppressOutput: () => false,
  runPythonCmd: async () => ({ ok: false, code: 127, output: "" }),
  enterPerlRepl: () => {},
  runRealBash: async () => ({ code: 0, out: "", err: "" }),
  runShellScript: async () => 0,
  getJobScheduler: () => ({ list: () => [], kill: () => 127, wait: async () => 0 }),
  onInterrupt: () => {},
  get keyCallbacks() { return []; },
  get interruptCallbacks() { return []; },
  sh2libFacade: {},
  qbe2wasm: null,
  readBin: async () => new Uint8Array(0),
  writeOut: async () => {},
  builtinCapture: null,
  ensureOtRuntime: async () => null,
  wasmRunner: null,
  goCmd: async () => 0,
  isPrivilegedUser: () => true,
  getBgJobs: () => ({ list: () => [], kill: () => 127, wait: async () => 0 }),
  runViaTranspiler: async () => 0,
  runSegment: async () => ({ ok: true, code: 0, output: "" }),
  promptRepl: () => {},
  enterRepl: () => {},
  exit: () => {},
  nodeEnv: {},
  nodeCwd: () => "/",
};
const { builtins: bound } = createShellCore(shellCtx);
let stdinBuf = "";

// seed a test file in the VFS
await fs.write("/home/remaining-test.txt", "one two three\nfour five\nsix\n");

// ── the shell-command batch (bare-prompt builtins) ─────────────
stdout._buf = ""; stderr._buf = "";
let code = await bound.hostname([]);
check("hostname prints", stdout._buf, "jtsh");
check("hostname exit", code, 0);

stdout._buf = "";
code = await bound.id([]);
check("id prints uid/gid", stdout._buf, "uid=1000(jtsh) gid=1000(jtsh) groups=1000(jtsh)");
stdout._buf = "";
await bound.id(["-un"]);
check("id -un prints user name", stdout._buf, "jtsh");

stdout._buf = "";
code = await bound.env([]);
check("env prints PATH", stdout._buf.includes("PATH=/bin:/usr/bin"), true);
check("env exit", code, 0);

stdout._buf = "";
code = await bound.stat(["/home/remaining-test.txt"]);
check("stat prints File:", stdout._buf.includes("File: /home/remaining-test.txt"), true);
check("stat prints Size:", stdout._buf.includes("Size: 28"), true);
check("stat exit", code, 0);

stdout._buf = "";
code = await bound.du(["-s", "/home/remaining-test.txt"]);
check("du -s prints total", stdout._buf, "28\t/home/remaining-test.txt");
check("du exit", code, 0);

stdout._buf = "";
code = await bound.df([]);
check("df prints header", stdout._buf.includes("Filesystem"), true);
check("df exit", code, 0);

stdout._buf = "";
code = await bound.xxd(["-p", "/home/remaining-test.txt"]);
check("xxd -p hex", stdout._buf.replace(/\s+/g, ""), "6f6e652074776f2074687265650a666f757220666976650a7369780a");
check("xxd exit", code, 0);
stdout._buf = "";
await fs.write("/home/remaining-hex.txt", "6f6e65");
code = await bound.xxd(["-r", "/home/remaining-hex.txt"]);
check("xxd -r reverse", stdout._buf, "one");
check("xxd -r exit", code, 0);
await fs.remove("/home/remaining-hex.txt");

stdout._buf = "";
stdinBuf = "a b c\n";
code = await bound.xargs(["echo"]);
check("xargs echo", stdout._buf, "a b c");
check("xargs exit", code, 0);
stdout._buf = "";
stdinBuf = "a b c\n";
await bound.xargs(["-n", "1", "echo"]);
check("xargs -n 1", stdout._buf, "a\nb\nc");
stdout._buf = "";
stdinBuf = "hello\n";
await bound.xargs(["-I", "{}", "echo", "got: {}"]);
check("xargs -I replace", stdout._buf, "got: hello");

// yes — one line (the builtin loops until interrupted; fire the
// interrupt after the first write so we get exactly one line)
stdout._buf = "";
let yesHandler = null, yesWrites = 0;
const yesCtx = { ...shellCtx, stdout: { ...stdout, write(s) { stdout._buf += s; if (++yesWrites >= 1 && yesHandler) yesHandler(); } }, onInterrupt: (fn) => { yesHandler = fn; } };
const yesBound = createShellCore(yesCtx).builtins;
await yesBound.yes(["hi"]);
check("yes prints the line", stdout._buf, "hi");

// ── the uutils-wasm coverage (the rest of the doc's table) ─────
const table = ["wc","sort","uniq","cut","tr","tee","nl","paste","shuf","fold","seq","sleep","touch","date","basename","dirname","printenv","od","readlink","realpath","uname","expand","unexpand","split","csplit","fmt","mktemp","cksum","sum"];
for (const cmd of table) {
  check(`uutils covers ${cmd}`, UUTILS_COMMANDS.has(cmd), true);
}

// ── the debashcl idiom lifts (transpiled output shape) ─────────
let r = await bashToJS(fs, "x=$(seq 1 5)");
check("$(seq 1 5) → sh2.seq", r.js.includes('sh2.seq("1", "5").join("\\n")'), true);
check("$(seq 1 5) no exec", !r.js.includes('exec("seq"'), true);

r = await bashToJS(fs, "n=$(wc -l /home/remaining-test.txt)");
check("wc -l FILE → sh2.lineCount", r.js.includes('sh2.lineCount("/home/remaining-test.txt")'), true);
check("wc -l FILE no exec", !r.js.includes('exec("wc"'), true);

r = await bashToJS(fs, "n=$(wc -w /home/remaining-test.txt)");
check("wc -w FILE → sh2.wordCount", r.js.includes('sh2.wordCount("/home/remaining-test.txt")'), true);

r = await bashToJS(fs, "n=$(wc -c /home/remaining-test.txt)");
check("wc -c FILE → sh2.byteCount", r.js.includes('sh2.byteCount("/home/remaining-test.txt")'), true);

r = await bashToJS(fs, 'x=hello; if echo "$x" | grep -q ell; then echo yes; fi');
check("grep -q → String().includes", r.js.includes('.includes("ell")'), true);
check("grep -q no grepText", !r.js.includes("grepText"), true);

r = await bashToJS(fs, "test -f /home/remaining-test.txt && cat /home/remaining-test.txt");
check("test -f && cat → fileTest guard", r.js.includes('sh2.fileTest("-f", "/home/remaining-test.txt")'), true);
check("test -f && cat no builtin test", !r.js.includes('sh2.builtin("test"'), true);

// ── the idiom lifts EXECUTE correctly (runBash with a stub shell) ──
const runOut = [];
const runCtx = {
  stdout: { write: (s) => runOut.push(s) },
  stderr: { write: (s) => runOut.push("[err] " + s) },
  runCmd: async (cmdline) => {
    const cl = cmdline.trim();
    if (cl.startsWith("echo ")) return { out: cl.slice(5) + "\n", err: "", code: 0 };
    return { out: "", err: "", code: 0 };
  },
};
runOut.length = 0;
await runBash(fs, "x=$(seq 1 3); echo \"$x\"", { ...runCtx, args: [], argv0: "bash", stdin: "" });
check("executed $(seq 1 3)", runOut.join(""), "1\n2\n3\n");

runOut.length = 0;
await runBash(fs, "n=$(wc -l /home/remaining-test.txt); echo \"n=$n\"", { ...runCtx, args: [], argv0: "bash", stdin: "" });
check("executed wc -l FILE", runOut.join(""), "n=3\n");

runOut.length = 0;
await runBash(fs, 'x=hello; if echo "$x" | grep -q zzz; then echo yes; else echo no; fi', { ...runCtx, args: [], argv0: "bash", stdin: "" });
check("executed grep -q no-match", runOut.join(""), "no\n");

runOut.length = 0;
await runBash(fs, 'x=hello; if echo "$x" | grep -q ell; then echo yes; else echo no; fi', { ...runCtx, args: [], argv0: "bash", stdin: "" });
check("executed grep -q match", runOut.join(""), "yes\n");

runOut.length = 0;
await runBash(fs, "test -f /home/remaining-test.txt && cat /home/remaining-test.txt", { ...runCtx, args: [], argv0: "bash", stdin: "" });
check("executed test -f && cat", runOut.join(""), "one two three\nfour five\nsix\n");

// ── the wasm binaries are built and registered ─────────────────
const { WasmerRegistry } = await import("./src/wasmer.js");
const reg = new WasmerRegistry(fs);
const names = reg.list().map((p) => p.name);
check("awk registered", names.includes("awk"), true);
check("bzip2 registered", names.includes("bzip2"), true);
check("xz registered", names.includes("xz"), true);
const { readFile } = await import("node:fs/promises");
for (const n of ["awk", "bzip2", "xz"]) {
  try {
    const b = await readFile("www/wasm-bin/" + n + ".wasm");
    check(`${n}.wasm built`, b.length > 1000, true);
  } catch {
    check(`${n}.wasm built`, false, true);
  }
}

// ── functional wasm checks: the binaries actually transform data ──
const { WasmRunner } = await import("./src/wasm.js");
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const runWasm = async (name, args, stdin) => {
  const runner = new WasmRunner(fs);
  await fs.write("/usr/bin/" + name + ".wasm", new Blob([new Uint8Array(await readFile("www/wasm-bin/" + name + ".wasm"))]));
  await runner.run("/usr/bin/" + name + ".wasm", [name, ...args], stdin);
  return { code: runner.getExitCode(), out: runner.getStdout(), err: runner.getStderr() };
};
// bzip2 roundtrip: compress then decompress a known stream
const bzStream = hexToBytes("425a68393141592653590eeaccfc00000251800010400012448010200022" + "1a68da8430201cd851e2ee48a70a1201dd599f80");
const bz = await runWasm("bzip2", ["-d"], bzStream);
check("bzip2 -d decodes known stream", bz.code === 0 && bz.out === "hello bz\n", true);
// xz is decompress-only (busybox xz = unxz); decode a known stream
const xzStream = hexToBytes("fd377a585a000004e6d6b4460200210116000000742fe5a301000868656c" + "6c6f20787a0a00000000c1493afa6352145a000121096c18c5d51fb6f37d010000000004595a");
const xz = await runWasm("xz", ["-d"], xzStream);
check("xz -d decodes known stream (decompress-only)", xz.code === 0 && xz.out === "hello xz\n", true);
// awk fields
const awk = await runWasm("awk", ["{print $2}"], new TextEncoder().encode("a b c\n"));
check("awk prints 2nd field", awk.code === 0 && awk.out === "b\n", true);

console.log(failures === 0 ? "\n✓ remaining-tools: all tests pass" : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
