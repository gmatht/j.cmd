// otranspiler v2 — the unified transpiler command (debashc's successor).
//
// One command over the frontend fleet, extension-driven — the browser
// port of the native otranspiler (gmatht/sh2loop/otranspiler):
//
//   otranspiler <input> [<output>] [flags]
//     input  file.{sh,go,py,c,pl,zsh,fish,shir}   (no ext = sh; - = stdin: A1, or source with --source-lang)
//     output {-,file}.{js,pl,c,go,py,java,rs,zig,sh,shir}  (no ext = js; - = stdout)
//   flags:
//     --shir            output the contract (A1 shIR JSON) instead of rendering
//     --target L        force the target language (js|pl|c|go|py|java|rs|zig|sh|shir)
//     --source-lang L   force the source language (sh|go|py|c|pl|zsh|fish|shir)
//     --run             js target: also execute the generated JS
//     -h|--help         usage
//
// Pipeline: source → A1 shIR contract → render, exactly like the native
// tool — ONE contract, every target:
//   sh/go/py/c/pl/zsh/fish → A1 shIR via the UNIFIED frontend
//        (busybox: all SEVEN frontend libraries — posix-sh-go (shell),
//        go-sh, py-sh-go, c-sh-go, perl-sh-go, zsh-sh-go, fish-sh-go —
//        + the shared shir-emit-go emitter + the dispatcher CLI, merged
//        into ONE stdlib-only main.go), BUILT ON FIRST USE with the
//        in-browser go toolchain and cached in /tmp (one artifact, one
//        Go runtime, one build; only rebuilt when the vendored sources
//        change)
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

// ── the vendored go source frontends (www/bin/<frontend>/) ───────
// Every source frontend is a plain Go program. The browser go toolchain
// builds a SINGLE stdlib-only file, so the command merges all SEVEN
// frontend libraries + the shared A1 JSON emitter (shir-emit-go) + the
// dispatcher CLI into ONE main.go: package/import lines stripped,
// imports unioned, per-part name prefixes so no identifiers collide
// (every top-level decl — func/type/var/const + const/var block members
// — and its references, skipping string/char/raw-string literals and
// // comments: Go char literals like '"' break naive "string literal"
// regexes). posix-sh-go is a package-main CLI, so its main() is renamed
// (sh_main) and the dispatcher calls its library entry shirForSource.
// The vendored copies are the source of truth (sync from
// gmatht/sh2loop/frontends/<frontend>/).
var FRONTEND_DIRS = { c: "c-sh-go", fish: "fish-sh-go", go: "go-sh", pl: "perl-sh-go", py: "py-sh-go", sh: "posix-sh-go", zsh: "zsh-sh-go" };
var FRONTEND_FILES = {
  c:    ["main.go"],
  fish: ["fish-sh-go.go"],
  go:   ["go-sh.go"],
  pl:   ["main.go"],
  py:   ["main.go"],
  sh:   ["main.go", "analysis.go", "lowering.go"],
  zsh:  ["main.go", "analysis.go", "lowering.go"],
};
var PREFIX_MAIN = { sh: true };                  // posix-sh-go's main() → sh_main (dispatcher owns main)
var DISPATCH_CLI = "busybox/main.go";            // the merged CLI (browser dispatcher)
var SHIR_EMIT = "shir-emit-go/emit.go";
var SCRATCH = "/tmp/otranspiler-busybox";        // the one frontend build + wasm cache

function stripPkg(s) {
  return s.split("\n").filter(function (ln) { return !/^package \w+\s*$/.test(ln); }).join("\n");
}
function stripImports(s) {
  return s
    .replace(/import \(\n[\s\S]*?\n\)\n?/, "")
    .replace(/^import "[^"]+"\s*\n?/m, "");
}
function extractImports(s) {
  var m = s.match(/import \(\n([\s\S]*?)\n\)/);
  if (!m) return [];
  return m[1].split("\n").map(function (x) { return x.trim(); })
    .filter(function (x) { return /^"[^"]+"$/.test(x); })
    .map(function (x) { return x.slice(1, -1); });
}
// Rename every top-level decl (and its identifier references) with a
// prefix, skipping string/char/raw-string literals and // comments.
function prefixBody(s, pre, prefixMain) {
  var names = new Set();
  var inBlock = false;
  for (var ln of s.split("\n")) {
    var t = ln.trim();
    var m = ln.match(/^(?:func|type|var|const)\s+([A-Za-z_]\w*)/);
    if (m && (m[1] !== "main" || prefixMain)) names.add(m[1]);
    if (/^(?:var|const)\s*\(\s*$/.test(t)) { inBlock = true; continue; }
    if (t === ")") { inBlock = false; continue; }
    if (inBlock) {
      var bm = ln.match(/^\s*([A-Za-z_]\w*)/);
      if (bm && bm[1] !== "_") names.add(bm[1]);
    }
  }
  var out = "";
  var state = "code"; // code | dq | sq | raw | line
  for (var i = 0; i < s.length; ) {
    var ch = s[i];
    if (state === "dq" || state === "sq" || state === "raw") {
      out += ch;
      if (ch === "\\" && state !== "raw") { out += s[i + 1] || ""; i += 2; continue; }
      var close = state === "dq" ? '"' : state === "sq" ? "'" : "`";
      if (ch === close) state = "code";
      i++;
      continue;
    }
    if (state === "line") {
      out += ch;
      if (ch === "\n") state = "code";
      i++;
      continue;
    }
    if (ch === '"') { state = "dq"; out += ch; i++; continue; }
    if (ch === "'") { state = "sq"; out += ch; i++; continue; }
    if (ch === "`") { state = "raw"; out += ch; i++; continue; }
    if (ch === "/" && s[i + 1] === "/") { state = "line"; out += "//"; i += 2; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      var j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      var word = s.slice(i, j);
      out += names.has(word) ? pre + word : word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Fetch one vendored frontend source file (browser: fetch; node: disk).
async function readVendoredFile(name) {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    var readFileSync = (await import("node:fs")).readFileSync;
    return readFileSync(process.cwd() + "/www/bin/" + name, "utf8");
  }
  var resp = await fetch("bin/" + name);
  if (!resp.ok) throw new Error("vendored frontend source not found (" + resp.status + ")");
  return resp.text();
}

// Merge the seven frontend libraries + the A1 emitter + the dispatcher
// CLI into a single stdlib-only main.go (the unified frontend binary).
async function mergedBusyboxSource() {
  var parts = [];
  var impSet = {};
  var allSrc = [];
  for (var lang of Object.keys(FRONTEND_FILES)) {
    var dir = FRONTEND_DIRS[lang];
    var body = "";
    for (var f of FRONTEND_FILES[lang]) {
      var src = await readVendoredFile(dir + "/" + f);
      allSrc.push(src);
      body += (body ? "\n" : "") + stripImports(stripPkg(src));
    }
    parts.push(prefixBody(body.replace(/shiremit\./g, "shiremit_"), lang + "_", PREFIX_MAIN[lang]));
  }
  var emit = await readVendoredFile(SHIR_EMIT);
  allSrc.push(emit);
  parts.push(prefixBody(stripImports(stripPkg(emit)), "shiremit_"));
  var cli = await readVendoredFile(DISPATCH_CLI);
  allSrc.push(cli);
  parts.push(prefixBody(stripImports(stripPkg(cli)), "cli_"));
  allSrc.forEach(function (f) {
    extractImports(f).forEach(function (i) { impSet[i] = true; });
  });
  var imports = Object.keys(impSet).sort();
  return (
    "// Generated unified frontend (busybox) for the browser go toolchain:\n" +
    "// seven frontend libs + shir-emit-go + the dispatcher CLI, merged\n" +
    "// from www/bin/ (source of truth: gmatht/sh2loop/frontends).\n" +
    "package main\n\n" +
    "import (\n" + imports.map(function (i) { return '\t"' + i + '"'; }).join("\n") + "\n)\n\n" +
    parts.join("\n") + "\n"
  );
}

// Ensure the unified frontend is built in /tmp (build on first use). The
// in-browser go toolchain (go build via the shell's `go` command) turns
// the merged stdlib-only source into main.wasm; the wasm is cached and
// only rebuilt when the merged source changes.
async function ensureBusybox() {
  try { await fs.write(SCRATCH + "/.directory", ""); } catch (e) {}  // mkdir (fs convention)
  var merged = await mergedBusyboxSource();
  var mainPath = SCRATCH + "/main.go";
  var wasmPath = SCRATCH + "/main.wasm";   // `go build main.go` → main.wasm (name follows the source)
  var st = await fs.stat(mainPath).catch(function () { return null; });
  var fresh = false;
  if (st) {
    try { fresh = (await fs.read(mainPath)) === merged; } catch (e) { fresh = false; }
  }
  if (!fresh) {
    await fs.write(mainPath, merged);
    // Build via the shell's `go` command. The `cd` into the scratch dir
    // must not leak into the shell's persistent cwd — restore it.
    var prevCwd = fs.cwd;
    var b;
    try {
      b = await shell.runLine("cd " + SCRATCH + " && go build main.go");
    } finally {
      if (fs.cwd !== prevCwd) await shell.runLine("cd " + prevCwd).catch(function () {});
    }
    if (!b || b.code !== 0) {
      var bmsg = (b && (String(b.err || "").trim() || String(b.out || "").trim())) || (b ? "go build exited " + b.code : "go build failed");
      throw new Error("frontend build failed: " + bmsg.slice(0, 300));
    }
  }
  var w = await fs.stat(wasmPath).catch(function () { return null; });
  if (!w) throw new Error("frontend wasm missing after build (try again)");
  return wasmPath;
}

// ── source acquisition ──────────────────────────────────────────
async function readSource(input) {
  if (input === "-") return stdin;
  try { return await fs.read(input); } catch (e) { return input; } // inline source
}

var SOURCE_EXTS = { sh: 1, go: 1, py: 1, c: 1, pl: 1, zsh: 1, fish: 1, shir: 1 };
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
// full bash); go/py/c/pl/zsh/fish → A1 via the unified merged frontend
// (busybox). ONE contract, every target.
async function contractFor(srcLang, source, srcName) {
  if (srcLang === "sh") {
    var a1 = await sh2lib.shir(source);           // the debashl core (full bash)
    return JSON.parse(a1);
  }
  if (FRONTEND_FILES[srcLang] || srcLang === "shir") {
    var inputPath = srcName;
    var st = null;
    try { st = await fs.stat(absPath(srcName)); } catch (e) {}
    if (!st) {
      inputPath = "/tmp/otranspiler-in." + (srcLang === "shir" ? "shir" : srcLang);
      await fs.write(inputPath, source);
    }
    if (srcLang === "shir") {
      var raw = await fs.read(inputPath);
      return JSON.parse(raw);                      // the input IS the contract
    }
    var wasmPath = await ensureBusybox();          // one unified frontend build
    var lang = srcLang === "pl" ? "perl" : srcLang;  // dispatcher lang names
    var r = await shell.runLine(wasmPath + " --lang " + lang + " --shir " + absPath(inputPath) + " --raw");
    var out = String((r && r.out) || "").trim();
    var rerr = String((r && r.err) || "").trim();
    if (!r || r.code !== 0) {
      var msg = out || rerr || "frontend exited " + (r ? r.code : "?");
      throw new Error(srcLang + " frontend: " + msg.slice(0, 300));
    }
    // The go runner may have mixed the A1 JSON with diagnostics — the
    // contract is the first {…} JSON document.
    var start = out.indexOf("{");
    if (start < 0) throw new Error(srcLang + " frontend: no A1 contract in output: " + out.slice(0, 120));
    return JSON.parse(out.slice(start));
  }
  throw new Error("source language '" + srcLang + "' not wired (sh | go | py | c | pl | zsh | fish | shir)");
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
  input  file.{sh,go,py,c,pl,zsh,fish,shir}   (no ext = sh; - = stdin: A1, or source with --source-lang)
  output {-,file}.{js,pl,c,go,py,java,rs,zig,sh,shir}  (no ext = js; - = stdout)
  --shir            output the contract (A1 shIR JSON) instead of rendering
  --target L        force the target language (js|pl|c|go|py|java|rs|zig|sh|shir)
  --source-lang L   force the source language (sh|go|py|c|pl|zsh|fish|shir)
  --run             js target: also execute the generated JS
  -h, --help        this help

Pipeline: source → A1 shIR contract → render (the unified otranspiler
interface — ONE contract, every target):
  sh → A1 via the otranspilerl core (full bash); go/py/c/pl/zsh/fish →
       A1 via the UNIFIED frontend (busybox: all seven frontend libs in
       one merged binary, built on first use from www/bin/<frontend>/
       with the in-browser go toolchain and cached in /tmp)
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
