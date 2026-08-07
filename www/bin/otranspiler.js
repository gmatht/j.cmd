// otranspiler v1 — the unified transpiler command (debashc's successor).
//
// One command over the frontend fleet, extension-driven — the browser
// port of the native otranspiler (gmatht/sh2loop/otranspiler):
//
//   otranspiler <input> [<output>] [flags]
//     input  file.{sh,go,py,c,pl,zsh,fish,shir}   (no ext = sh; - = stdin)
//     output {-,file}.{js,pl,c,sh,shir}           (no ext = js; - = stdout)
//   flags:
//     --shir            output the contract instead of rendering a target
//     --target L        force the target language (js|pl|c|sh|shir)
//     --source-lang L   force the source language (sh|go|py|c|pl|zsh|fish|shir)
//     --run             js target: also execute the generated JS
//     -h|--help         usage
//
// Pipeline: source → contract → render, exactly like the native tool.
//   sh → ESTree contract (debashcl.wasm) → js / pl / shir
//   go/py/c/pl/zsh/fish → A1 shIR contract via the UNIFIED frontend
//        (busybox) → js (estree) / pl / c / sh / shir — js/pl for A1
//        are the estree backend's growth path; c/sh render the A1
//        subset the frontends emit (refuse > guess).
//        The unified frontend: ONE merged main.go combining all six
//        frontend libraries (go-sh, py-sh-go, c-sh-go, perl-sh-go,
//        zsh-sh-go, fish-sh-go) + the shared shir-emit-go emitter + the
//        busybox CLI, built on FIRST USE from the vendored sources
//        (www/bin/<frontend>/) with the in-browser go toolchain
//        (go build → one wasm cached in /tmp, run via the js/wasm
//        runner — one artifact, one Go runtime, one build; only
//        rebuilt when the vendored sources change).
//
// The old debashc invocation forms still work (drop-in):
//   otranspiler parse 'echo hi'           → contract (ESTree JSON)
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
// Every source frontend is a plain Go program: a <pkg>lib library (the
// parser/emitter) + a thin cmd CLI. The browser go toolchain builds a
// SINGLE stdlib-only file, so the command merges ALL SIX frontend
// libraries + the shared A1 JSON emitter (shir-emit-go) + the busybox
// CLI into ONE main.go (the sh2loop fleet's own unified-binary answer):
// package/import lines stripped, imports unioned, cross-package
// references unqualified (cli: <pkgref>. → <lang>_; libs: shiremit. →
// shiremit_), and every top-level decl (func/type/var/const + const/var
// block members) + its identifier references renamed with a per-part
// prefix — skipping string/char/raw-string literals and // comments (Go
// char literals like '"' break naive "string literal" regexes). The
// merge mirrors the upstream layout; the vendored copies are the source
// of truth (sync from gmatht/sh2loop/frontends/<frontend>/).
var FRONTEND_DIRS = { c: "c-sh-go", fish: "fish-sh-go", go: "go-sh", pl: "perl-sh-go", py: "py-sh-go", zsh: "zsh-sh-go" };
var FRONTEND_FILES = {
  c:    ["main.go"],
  fish: ["fish-sh-go.go"],
  go:   ["go-sh.go"],
  pl:   ["main.go"],
  py:   ["main.go"],
  zsh:  ["main.go", "analysis.go", "lowering.go"],
};
var FRONTEND_PKGREF = { c: "clib", fish: "fishlib", go: "golib", pl: "pllib", py: "pylib", zsh: "zshlib" };
var BUSYBOX_CLI = "busybox/main.go";
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
function prefixBody(s, pre) {
  var names = new Set();
  var inBlock = false;
  for (var ln of s.split("\n")) {
    var t = ln.trim();
    var m = ln.match(/^(?:func|type|var|const)\s+([A-Za-z_]\w*)/);
    if (m && m[1] !== "main") names.add(m[1]);
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

// Merge the six frontend libraries + the A1 emitter + the busybox CLI
// into a single stdlib-only main.go (the unified frontend binary).
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
    parts.push(prefixBody(body.replace(/shiremit\./g, "shiremit_"), lang + "_"));
  }
  var emit = await readVendoredFile(SHIR_EMIT);
  allSrc.push(emit);
  parts.push(prefixBody(stripImports(stripPkg(emit)), "shiremit_"));
  var cli = await readVendoredFile(BUSYBOX_CLI);
  allSrc.push(cli);
  var cliBody = stripImports(stripPkg(cli));
  for (var lang2 of Object.keys(FRONTEND_FILES)) {
    cliBody = cliBody.replace(new RegExp("\\b" + FRONTEND_PKGREF[lang2] + "\\.", "g"), lang2 + "_");
  }
  parts.push(prefixBody(cliBody, "cli_"));
  allSrc.forEach(function (f) {
    extractImports(f).forEach(function (i) { impSet[i] = true; });
  });
  var imports = Object.keys(impSet).sort();
  return (
    "// Generated unified frontend (busybox) for the browser go toolchain:\n" +
    "// six frontend libs + shir-emit-go + the busybox CLI, merged from\n" +
    "// www/bin/ (source of truth: gmatht/sh2loop/frontends).\n" +
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

// Absolutize a VFS path (for the frontend's file argument).
function absPath(p) {
  try { return fs._resolve(p); } catch (e) { return p; }
}

// ── the contract (source → language-neutral JSON) ───────────────
async function contractFor(srcLang, source, srcName) {
  if (srcLang === "sh") {
    return await sh2lib.toEstree(source);          // ESTree contract (debashcl)
  }
  if (FRONTEND_FILES[srcLang]) {
    // The frontend reads a FILE (os.Args[1]) — materialize the source
    // into the VFS when it didn't come from one.
    var inputPath = srcName;
    var st = null;
    try { st = await fs.stat(absPath(srcName)); } catch (e) {}
    if (!st) {
      inputPath = "/tmp/otranspiler-in." + srcLang;
      await fs.write(inputPath, source);
    }
    var wasmPath = await ensureBusybox();          // one unified frontend build
    var lang = srcLang === "pl" ? "perl" : srcLang;  // busybox's own lang names
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
  if (srcLang === "shir") {
    return JSON.parse(source);                     // the input IS the contract
  }
  throw new Error("source language '" + srcLang + "' not wired (sh | go | py | c | pl | zsh | fish | shir)");
}

// ── rendering (contract → target) ───────────────────────────────
// js/pl render the ESTree contract (sh sources, via sh2lib). The A1
// contract (go/py/c/pl/zsh/fish sources) renders to sh / c with the
// minimal subset renderers below — mirroring the native otranspiler's
// --shir-in-sh / --shir-in-c backends (refuse > guess: anything outside
// the frontend subset is a hard error, never a silent mis-render).

// A1 value → shell source
function shValue(e) {
  switch (e.type) {
    case "Str": return e.value;
    case "Interpolate":
      return e.parts.map(function (p) { return p.kind === "lit" ? p.text : "${" + p.var + "}"; }).join("");
    case "Array": return e.elements.map(shValue).join(" ");
    case "Call":
      if (e.func === "getVar") return "$" + (e.args[0] && e.args[0].value);
      if (e.func === "exec") return e.args.map(shValue).join(" ");
      throw new Error("A1→sh: unrenderable call '" + e.func + "'");
    default: throw new Error("A1→sh: unrenderable expr '" + e.type + "'");
  }
}
function a1ToSh(contract) {
  return contract.stmts.map(function (st) {
    if (st.type === "Expr") return shValue(st.expr);
    if (st.type === "Assign") {
      return st.targets.map(function (t) { return t.var + "=" + shValue(st.expr); }).join(" ");
    }
    throw new Error("A1→sh: unrenderable stmt '" + st.type + "'");
  }).join("\n") + "\n";
}

// A1 value → C expression (echo/assign/getVar subset)
function cValue(e) {
  switch (e.type) {
    case "Str": return JSON.stringify(e.value);
    case "Interpolate":
      return e.parts.map(function (p) {
        return p.kind === "lit" ? JSON.stringify(p.text) : "(" + p.var + "? " + p.var + " : \"\")";
      }).join("");
    case "Call":
      if (e.func === "getVar") return "(" + e.args[0].value + "? " + e.args[0].value + " : \"\")";
      throw new Error("A1→c: unrenderable call '" + e.func + "'");
    default: throw new Error("A1→c: unrenderable expr '" + e.type + "'");
  }
}
function a1ToC(contract) {
  var decls = [], body = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") {
      st.targets.forEach(function (t) { decls.push("char *" + t.var + " = " + cValue(st.expr) + ";"); });
    } else if (st.type === "Expr" && st.expr.type === "Call" && st.expr.func === "exec") {
      var args = st.expr.args || [];
      var cmd = args[0] && args[0].value;
      var words = (args[1] && args[1].elements) || [];
      if (cmd === "echo") {
        var fmt = "", cargs = [];
        words.forEach(function (w) {
          if (w.type === "Call" && w.func === "getVar") {
            fmt += "%s";
            cargs.push("(" + w.args[0].value + "? " + w.args[0].value + " : \"\")");
          } else {
            fmt += String(cValue(w)).replace(/%/g, "%%").replace(/^"(.*)"$/, "$1");
          }
        });
        body.push('printf("' + fmt + '\\n"' + (cargs.length ? ", " + cargs.join(", ") : "") + ");");
      } else {
        throw new Error("A1→c: exec of '" + cmd + "' not wired (echo only in the browser renderer)");
      }
    } else {
      throw new Error("A1→c: unrenderable stmt '" + st.type + "'");
    }
  });
  return (
    "// Generated by otranspiler (A1 shIR → C, browser renderer)\n" +
    "#include <stdio.h>\n" +
    "int main(void) {\n" +
    (decls.length ? decls.map(function (d) { return "  " + d; }).join("\n") + "\n" : "") +
    body.map(function (l) { return "  " + l; }).join("\n") + "\n" +
    "  return 0;\n" +
    "}\n"
  );
}

async function render(target, contract, source, srcLang) {
  if (target === "shir") {
    return JSON.stringify(contract, null, 2);
  }
  if (target === "js") {
    if (srcLang === "sh") return await sh2lib.bashToJs(source);  // ESTree contract → JS
    throw new Error("A1 → js rendering is the estree backend's growth path; emit the contract with --shir");
  }
  if (target === "pl") {
    if (srcLang === "sh") return await sh2lib.toPerl(source);
    throw new Error("A1 → perl rendering not wired; emit the contract with --shir");
  }
  if (target === "sh") {
    if (srcLang === "sh") return source;         // ESTree contract → sh = the source itself
    return a1ToSh(contract);                      // A1 contract → shell
  }
  if (target === "c") {
    if (srcLang === "sh") throw new Error("ESTree → c rendering not wired; feed a go/py/c/pl/zsh/fish source (A1 contract)");
    return a1ToC(contract);                       // A1 contract → C
  }
  throw new Error("target '" + target + "' not wired (js | pl | c | sh | shir)");
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
  output {-,file}.{js,pl,c,sh,shir}           (no ext = js; - = stdout)
  --shir            output the contract (ESTree JSON for sh; A1 shIR for go/py/c/pl/zsh/fish)
  --target L        force the target language (js|pl|c|sh|shir)
  --source-lang L   force the source language (sh|go|py|c|pl|zsh|fish|shir)
  --run             js target: also execute the generated JS
  -h, --help        this help

Pipeline: source → contract → render (the unified otranspiler interface):
  sh → ESTree contract (debashcl.wasm) → js / pl / shir
  go/py/c/pl/zsh/fish → A1 contract via the UNIFIED frontend (busybox —
       all six frontend libs in one merged binary), built on first use
       from www/bin/<frontend>/ with the in-browser go toolchain and
       cached in /tmp → c / sh / shir (js/pl = the estree backend's
       growth path)

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
  else if (a.indexOf("-") === 0) { console.log("otranspiler: unknown flag " + a); return 2; }
  else positional.push(a);
}

var input = positional[0], output = positional.length > 1 ? positional[1] : "";
if (!input) { console.log(usage()); return 2; }

var srcLang = forceSrc || langOf(input);
var tgtLang = forceTgt;
if (!tgtLang && output) tgtLang = langOf(output);
if (!tgtLang) tgtLang = "js";                    // the default target

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
    var fn = new Function("sh2", "fs", "env", "args", "return (async () => { " + text + " })();");
    var code = await fn(sh2, fs, env, args.slice(2));
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
