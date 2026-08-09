// otranspiler v2 — the unified transpiler command (debashc's successor).
//
// One command over the frontend fleet, extension-driven — the browser
// port of the native otranspiler (gmatht/sh2loop/otranspiler):
//
//   otranspiler <input> [<output>] [flags]
//     input  file.{sh,go,py,c,pl,zsh,fish,bat,shir}   (no ext = sh; - = stdin: A1, or source with --source-lang)
//     output {-,file}.{js,pl,c,go,py,java,rs,zig,sh,shir}  (no ext = js; - = stdout)
//   flags:
//     --shir            output the contract (A1 shIR JSON) instead of rendering
//     --target L        force the target language (js|pl|c|go|py|java|rs|zig|sh|shir)
//     --source-lang L   force the source language (sh|go|py|c|pl|zsh|fish|bat|shir)
//     --run             js target: also execute the generated JS
//     -h|--help         usage
//
// Pipeline: source → A1 shIR contract → render, exactly like the native
// tool — ONE contract, every target:
//   sh/go/py/c/pl/zsh/fish/bat → A1 shIR via the UNIFIED frontend
//        (busybox — all eight frontend libs merged into ONE binary;
//        the SAME artifact the otranspiler GUI uses: the shipped
//        prebuilt www/wasm-bin/otranspiler-busybox.wasm, staged by
//        src/busybox.js — built with the in-browser go toolchain only
//        if the prebuilt is ever missing)
//   A1 → js (estree → JS via src/estree.js) / pl / c / go / py / java /
//        rs / zig / sh / shir — the REAL backend renderers (the
//        otranspilerl library, the debashl core's --shir-in-<lang> family)
//
// The old debashc invocation forms still work (drop-in):
//   otranspiler parse 'echo hi'           → contract (A1 shIR JSON)
//   otranspiler parse --perl 'echo hi'    → perl
//   otranspiler file --estree x.sh        → contract
//   otranspiler file --perl x.sh          → perl
//
// NOTE on structure: the shell runs this file inside an async arrow
// (`return (async () => { <file> })();`), so the main flow must be
// top-level `await`/`return` — an IIFE's promise would be fire-and-
// forget and the batch shell would exit before it completed. And
// `shell.runLine` returns { out, err, code } — not { output }.
// -----------------------------------------------------------------

// ── the unified frontend (busybox) ────────────────────────────────
// Source languages other than sh (go/py/c/pl/zsh/fish) reach A1 through
// the unified frontend — ALL of the merge/build/stage machinery lives
// in src/busybox.js (shared with the otranspiler GUI and the `source`
// builtin) and is exposed to commands as sh2lib.busyboxA1. The artifact
// is the shipped prebuilt www/wasm-bin/otranspiler-busybox.wasm.


// ── source acquisition ──────────────────────────────────────────
async function readSource(input) {
  if (input === "-") return stdin;
  try { return await fs.read(input); } catch (e) { return input; } // inline source
}

var SOURCE_EXTS = { sh: 1, go: 1, py: 1, c: 1, pl: 1, zsh: 1, fish: 1, bat: 1, shir: 1 };
function langOf(path) {
  if (path === "-") return "shir";
  var ext = path.split(".").pop();
  return SOURCE_EXTS[ext] ? ext : "sh"; // no extension or anything else → shell
}
// The TARGET languages (a superset of the source exts — js/java/rs/zig
// are targets only). The output file's extension picks the target; `-`
// (stdout) and an extensionless output default to js (see the CLI).
var TARGET_EXTS = { js: 1, pl: 1, c: 1, go: 1, py: 1, java: 1, rs: 1, zig: 1, sh: 1, shir: 1 };
function targetLangOf(path) {
  if (path === "-") return "";
  var ext = path.split(".").pop();
  return TARGET_EXTS[ext] ? ext : "";
}

// Absolutize a VFS path (for the frontend's file argument).
function absPath(p) {
  try { return fs._resolve(p); } catch (e) { return p; }
}

// ── the contract (source → A1 shIR JSON) ────────────────────────
// sh → A1 via the otranspilerl library's core (the real debashl parser,
// full bash); go/py/c/pl/zsh/fish/bat → A1 via the unified merged
// frontend (busybox). ONE contract, every target.
async function contractFor(srcLang, source, srcName) {
  if (srcLang === "sh") {
    var a1 = await sh2lib.shir(source);           // the debashl core (full bash)
    return JSON.parse(a1);
  }
  if (srcLang === "shir") {
    var inputPath = srcName;
    var st = null;
    try { st = await fs.stat(absPath(srcName)); } catch (e) {}
    if (!st) {
      inputPath = "/tmp/otranspiler-in.shir";
      await fs.write(inputPath, source);
    }
    var raw = await fs.read(inputPath);
    return JSON.parse(raw);                      // the input IS the contract
  }
  // go/py/c/pl/zsh/fish/bat → A1 via the unified frontend — the same
  // busybox artifact the otranspiler GUI uses (sh2lib.busyboxA1)
  if (!SOURCE_EXTS[srcLang]) {
    throw new Error("source language '" + srcLang + "' not wired (sh | go | py | c | pl | zsh | fish | bat | shir)");
  }
  return await sh2lib.busyboxA1(source, srcLang);
}

// ── rendering (A1 contract → target) ────────────────────────────
// The REAL backend renderers — the otranspilerl library (the debashl
// core's --shir-in-<lang> family: js/estree, pl, c, go, py, java, rs,
// zig, sh + shir). js renders the estree AST through the shell's own
// emitter (src/estree.js) so the result is runnable JS against the
// sh2.* runtime.
async function render(target, contract, source, srcLang) {
  if (target === "shir") return JSON.stringify(contract, null, 2);
  const a1 = JSON.stringify(contract);
  if (target === "js") {
    const estree = JSON.parse(await sh2lib.render(a1, "js"));
    return await sh2lib.estreeToJs(estree);
  }
  return await sh2lib.render(a1, target);
}

// Emit text to the shell (console.log is captured into the pipe/redirect
// machinery — a direct process.stdout.write would bypass it).
function emit(text) {
  var s = String(text);
  if (s.endsWith("\n")) s = s.slice(0, -1);
  console.log(s);
}

// ── CLI (top-level awaits — see the NOTE above) ────────────────
function usage() {
  return `otranspiler <input> [<output>] [flags]
  input  file.{sh,go,py,c,pl,zsh,fish,bat,shir}   (no ext = sh; - = stdin: A1, or source with --source-lang)
  output {-,file}.{js,pl,c,go,py,java,rs,zig,sh,shir}  (no ext = js; - = stdout)
  --shir            output the contract (A1 shIR JSON) instead of rendering
  --target L        force the target language (js|pl|c|go|py|java|rs|zig|sh|shir)
  --source-lang L   force the source language (sh|go|py|c|pl|zsh|fish|bat|shir)
  --run             js target: also execute the generated JS
  -h, --help        this help

Pipeline: source → A1 shIR contract → render (the unified otranspiler
interface — ONE contract, every target):
  sh → A1 via the otranspilerl core (full bash); go/py/c/pl/zsh/fish/bat →
       A1 via the UNIFIED frontend (busybox: all eight frontend libs in
       one merged binary — the shipped prebuilt
       www/wasm-bin/otranspiler-busybox.wasm, the same artifact the
       otranspiler GUI uses (src/busybox.js))
  A1 → js (estree → JS via src/estree.js) / pl / c / go / py / java /
       rs / zig / sh / shir — the REAL backend renderers (otranspilerl)

drop-in debashc forms: parse 'src' | parse --perl 'src' | file --estree x.sh | file --perl x.sh`;
}

if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.log(usage());
  return args.length ? 0 : 2;
}

// ── drop-in debashc forms (before flag parsing — they carry their own
//    --perl/--estree switches) ──
if (args[0] === "parse" || args[0] === "file") {
  var mode = args[0];
  var rest = args.slice(1);
  var perl = rest.indexOf("--perl") >= 0;
  rest = rest.filter(function (x) { return x !== "--perl" && x !== "--estree"; });
  var src, name;
  if (mode === "parse") {
    src = rest.join(" ");
    name = "-";
  } else {
    if (!rest.length) { console.log("otranspiler: file mode needs a file name"); return 2; }
    name = rest[0];
    src = await readSource(name);
  }
  try {
    var c = await contractFor("sh", src, name);
    emit(await render(perl ? "pl" : "shir", c, src, "sh"));
  } catch (e) { console.log("otranspiler: " + e.message); return 1; }
  return 0;
}

var forceSrc = "", forceTgt = "", doRun = false;
var positional = [];
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "--shir") forceTgt = "shir";
  else if (a === "--run") doRun = true;
  else if (a === "--source-lang") forceSrc = args[++i];
  else if (a.indexOf("--source-lang=") === 0) forceSrc = a.slice("--source-lang=".length);
  else if (a === "--target") forceTgt = args[++i];
  else if (a.indexOf("--target=") === 0) forceTgt = a.slice("--target=".length);
  else if (a === "-") positional.push(a);            // stdin marker, not a flag
  else if (/^-\.[A-Za-z0-9]{1,6}$/.test(a)) {
    // `-.sh` shorthand: stdout with that target (`-` + extension)
    positional.push("-");
    forceTgt = a.slice(2);
  }
  else if (a.indexOf("-") === 0) { console.log("otranspiler: unknown flag " + a); return 2; }
  else positional.push(a);
}

var input = positional[0], output = positional.length > 1 ? positional[1] : "";
if (!input) { console.log(usage()); return 2; }

var srcLang = forceSrc || langOf(input);
var tgtLang = forceTgt;
if (!tgtLang && output) tgtLang = targetLangOf(output);
if (!tgtLang) tgtLang = "js";                    // the default target
if (!{ js: 1, pl: 1, c: 1, go: 1, py: 1, java: 1, rs: 1, zig: 1, sh: 1, shir: 1 }[tgtLang]) {
  console.log("otranspiler: target '" + tgtLang + "' not wired (js | pl | c | go | py | java | rs | zig | sh | shir)");
  return 2;
}

try {
  var source = await readSource(input);
  var isFile = !!(await fs.stat(input).catch(function () { return null; }));
  var srcName = (input === "-" || !isFile)
    ? "/tmp/otranspiler-in." + (srcLang === "shir" ? "shir" : srcLang)
    : input;
  if (srcName !== input) await fs.write(srcName, source);
  var contract = await contractFor(srcLang, source, srcName);
  var text = await render(tgtLang, contract, source, srcLang);
  if (doRun && tgtLang === "js") {
    // "also execute" — the output file (when given) is still written
    if (output && output !== "-") await fs.write(output, text);
    // The estree output writes through process.stdout.write / reads
    // process.env — shim them (the shell itself survives).
    var pout = { write: (s) => { if (s) console.log(String(s).replace(/\n$/, "")); } };
    var proc = {
      stdout: pout, stderr: pout, pid: 1, argv: ["jtsh"], env: env || {},
      cwd: () => (fs.cwd !== undefined ? fs.cwd : "/"),
      chdir(p) { if (fs && fs.cwd !== undefined) fs.cwd = String(p).replace(/\/+$/, "") || "/"; },
      exit(code) { const e = new Error("__exit__" + code); e.exitCode = Number(code) || 0; throw e; },
    };
    var fn = new Function("sh2", "fs", "env", "process", "args", "return (async () => { " + text + " })();");
    try {
      var code = await fn(sh2, fs, env, proc, args.slice(2));
    } catch (e) {
      if (e && e.exitCode !== undefined) return e.exitCode;
      throw e;
    }
    return typeof code === "number" ? code : 0;
  }
  if (output && output !== "-") {
    await fs.write(output, text);
    return 0;
  }
  emit(text);
  return 0;
} catch (e) {
  console.log("otranspiler: " + e.message);
  return 1;
}
