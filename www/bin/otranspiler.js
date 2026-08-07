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
//   A1 → js (sh2.* runtime) / pl / c / go / py / java / rs / zig / sh / shir
//        — the browser renders (refuse > guess: anything outside the
//        frontend subset is a hard error, never a silent mis-render)
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

// Absolutize a VFS path (for the frontend's file argument).
function absPath(p) {
  try { return fs._resolve(p); } catch (e) { return p; }
}

// ── the contract (source → A1 shIR JSON) ────────────────────────
// EVERY source language (shell included) goes through the unified
// frontend — the sh frontend is posix-sh-go, byte-identical to the
// core's `debashc --shir` on its v1 subset. One contract, every target.
async function contractFor(srcLang, source, srcName) {
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
// The browser renders mirror the native --shir-in-<lang> backends
// (js/pl/c/go/py/sh/java/rs/zig + shir): js targets the shell's own
// sh2.* runtime; the rest emit runnable source in each language's
// minimal idiom for the frontend subset (echo/assign/getVar).
// Refuse > guess: anything outside the subset is a hard error, never
// a silent mis-render. `split` (IFS word-splitting) unwraps to its
// operand — the shell does the splitting natively, and each target
// language's echo/print renders the value.

function isEchoStmt(st) {
  return st.type === "Expr" && st.expr.type === "Call" && st.expr.func === "exec" &&
    st.expr.args && st.expr.args[0] && st.expr.args[0].value === "echo";
}
function echoWords(st) {
  return ((st.expr.args && st.expr.args[1] && st.expr.args[1].elements) || []);
}
// Normalize an echo arg list to [{lit}|{var}] tokens (split unwrapped).
function wordsOf(elements) {
  var out = [];
  function add(e) {
    if (e.type === "Str") out.push({ lit: e.value });
    else if (e.type === "Interpolate") {
      e.parts.forEach(function (p) { out.push(p.kind === "lit" ? { lit: p.text } : { var: p.var }); });
    } else if (e.type === "Call" && e.func === "getVar") out.push({ var: e.args[0].value });
    else if (e.type === "Call" && e.func === "split") add(e.args[0]);
    else throw new Error("A1→?: unrenderable echo word '" + e.type + "'");
  }
  elements.forEach(add);
  return out;
}
function escStr(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// A1 value → shell source
function shValue(e) {
  switch (e.type) {
    case "Str": return e.value;
    case "Interpolate":
      return e.parts.map(function (p) { return p.kind === "lit" ? p.text : "$" + p.var; }).join("");
    case "Array": return e.elements.map(shValue).join(" ");
    case "Call":
      if (e.func === "getVar") return "$" + (e.args[0] && e.args[0].value);
      if (e.func === "exec") return e.args.map(shValue).join(" ");
      if (e.func === "split") return shValue(e.args[0]);
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
      if (e.func === "split") return cValue(e.args[0]);
      throw new Error("A1→c: unrenderable call '" + e.func + "'");
    default: throw new Error("A1→c: unrenderable expr '" + e.type + "'");
  }
}
function a1ToC(contract) {
  var decls = [], body = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") {
      st.targets.forEach(function (t) { decls.push("char *" + t.var + " = " + cValue(st.expr) + ";"); });
    } else if (isEchoStmt(st)) {
      var fmt = "", cargs = [];
      wordsOf(echoWords(st)).forEach(function (w) {
        if (w.var) { fmt += "%s"; cargs.push("(" + w.var + "? " + w.var + " : \"\")"); }
        else fmt += escStr(w.lit).replace(/%/g, "%%");
      });
      body.push('printf("' + fmt + '\\n"' + (cargs.length ? ", " + cargs.join(", ") : "") + ");");
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

// A1 value → JS against the shell's sh2.* runtime
function jsValue(e) {
  switch (e.type) {
    case "Str": return JSON.stringify(e.value);
    case "Interpolate":
      return e.parts.map(function (p) {
        return p.kind === "lit" ? JSON.stringify(p.text) : "sh2.getVar(" + JSON.stringify(p.var) + ")";
      }).join(" + ");
    case "Array": return "[" + e.elements.map(jsValue).join(", ") + "]";
    case "Call":
      if (e.func === "getVar") return "sh2.getVar(" + JSON.stringify(e.args[0].value) + ")";
      if (e.func === "exec") return "sh2.exec(" + e.args.map(jsValue).join(", ") + ")";
      if (e.func === "split") return jsValue(e.args[0]);
      throw new Error("A1→js: unrenderable call '" + e.func + "'");
    default: throw new Error("A1→js: unrenderable expr '" + e.type + "'");
  }
}
function a1ToJs(contract) {
  return contract.stmts.map(function (st) {
    if (st.type === "Expr" && st.expr.type === "Call" && st.expr.func === "exec") {
      return "await " + jsValue(st.expr) + ";";
    }
    if (st.type === "Assign") {
      var t = st.targets[0].var;
      return "sh2.setVar(" + JSON.stringify(t) + ", " + jsValue(st.expr) + ");";
    }
    throw new Error("A1→js: unrenderable stmt '" + st.type + "'");
  }).join("\n") + "\n";
}

// A1 value → Perl (echo/assign/getVar subset, print-based)
function perlEchoString(words) {
  var s = "\"";
  words.forEach(function (w) {
    s += w.var ? "$" + w.var : escStr(w.lit).replace(/\$/g, "\\$");
  });
  s += "\\n\"";
  return s;
}
function a1ToPl(contract) {
  var lines = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") {
      st.targets.forEach(function (t) { lines.push("my $" + t.var + " = " + JSON.stringify(String(st.expr.value || "")) + ";"); });
    } else if (isEchoStmt(st)) {
      lines.push("print " + perlEchoString(wordsOf(echoWords(st))) + ";");
    } else {
      throw new Error("A1→pl: unrenderable stmt '" + st.type + "'");
    }
  });
  return (
    "#!/usr/bin/env perl\nuse strict;\nuse warnings;\n\n" +
    lines.join("\n") + "\n"
  );
}

// A1 → Go / Python / Java / Rust / Zig (echo/assign/getVar subset,
// minimal idiom mirroring the native backends' output style)
function assignValue(st) {
  var e = st.expr;
  if (e.type === "Str" || e.type === "Interpolate") return escStr(e.value || (e.parts && e.parts.map(function (p) { return p.text || ""; }).join("")) || "");
  throw new Error("A1→?: unrenderable assign value '" + e.type + "'");
}
function a1ToGo(contract) {
  var lines = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") st.targets.forEach(function (t) { lines.push(t.var + " := \"" + assignValue(st) + "\""); });
    else if (isEchoStmt(st)) {
      var args = wordsOf(echoWords(st)).map(function (w) { return w.var ? w.var : "\"" + assignValue({ expr: { type: "Str", value: w.lit } }) + "\""; });
      lines.push("fmt.Println(" + args.join(", ") + ")");
    } else throw new Error("A1→go: unrenderable stmt '" + st.type + "'");
  });
  return "package main\n\nimport \"fmt\"\n\nfunc main() {\n" + lines.map(function (l) { return "\t" + l; }).join("\n") + "\n}\n";
}
function a1ToPy(contract) {
  var lines = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") st.targets.forEach(function (t) { lines.push(t.var + " = \"" + assignValue(st) + "\""); });
    else if (isEchoStmt(st)) {
      var args = wordsOf(echoWords(st)).map(function (w) { return w.var ? w.var : "\"" + assignValue({ expr: { type: "Str", value: w.lit } }) + "\""; });
      lines.push("print(" + args.join(", ") + ")");
    } else throw new Error("A1→py: unrenderable stmt '" + st.type + "'");
  });
  return "#!/usr/bin/env python3\n" + lines.join("\n") + "\n";
}
function a1ToJava(contract) {
  var lines = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") st.targets.forEach(function (t) { lines.push("String " + t.var + " = \"" + assignValue(st) + "\";"); });
    else if (isEchoStmt(st)) {
      var parts = wordsOf(echoWords(st)).map(function (w) { return w.var ? w.var : "\"" + assignValue({ expr: { type: "Str", value: w.lit } }) + "\""; });
      var expr = parts.length === 1 ? parts[0] : '("" + ' + parts.join(' + " " + ') + ")";
      lines.push("System.out.println(" + expr + ");");
    } else throw new Error("A1→java: unrenderable stmt '" + st.type + "'");
  });
  return (
    "public class Sh2Program {\n" +
    "    public static void main(String[] args) throws Exception {\n" +
    lines.map(function (l) { return "        " + l; }).join("\n") + "\n" +
    "    }\n" +
    "}\n"
  );
}
function a1ToRs(contract) {
  var lines = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") st.targets.forEach(function (t) { lines.push("let " + t.var + " = \"" + assignValue(st) + "\";"); });
    else if (isEchoStmt(st)) {
      var words = wordsOf(echoWords(st));
      var fmt = "", args = [];
      words.forEach(function (w) {
        if (w.var) { fmt += "{}"; args.push(w.var); }
        else fmt += escStr(w.lit);
      });
      lines.push('println!("' + fmt + '"' + (args.length ? ", " + args.join(", ") : "") + ");");
    } else throw new Error("A1→rs: unrenderable stmt '" + st.type + "'");
  });
  return "fn main() {\n" + lines.map(function (l) { return "    " + l; }).join("\n") + "\n}\n";
}
function a1ToZig(contract) {
  var lines = [];
  contract.stmts.forEach(function (st) {
    if (st.type === "Assign") st.targets.forEach(function (t) { lines.push("var " + t.var + " = \"" + assignValue(st) + "\";"); });
    else if (isEchoStmt(st)) {
      var words = wordsOf(echoWords(st));
      var fmt = "", args = [];
      words.forEach(function (w) {
        if (w.var) { fmt += "{s} "; args.push(w.var); }
        else fmt += escStr(w.lit) + " ";
      });
      fmt = fmt.replace(/ $/, "");
      lines.push('std.debug.print("' + fmt + '\\n", .{' + (args.length ? args.join(", ") : "") + "});");
    } else throw new Error("A1→zig: unrenderable stmt '" + st.type + "'");
  });
  return (
    "const std = @import(\"std\");\n\n" +
    "pub fn main() !void {\n" +
    lines.map(function (l) { return "    " + l; }).join("\n") + "\n" +
    "}\n"
  );
}

async function render(target, contract, source, srcLang) {
  if (target === "shir") return JSON.stringify(contract, null, 2);
  if (target === "js") return a1ToJs(contract);
  if (target === "pl") return a1ToPl(contract);
  if (target === "sh") return a1ToSh(contract);
  if (target === "c") return a1ToC(contract);
  if (target === "go") return a1ToGo(contract);
  if (target === "py") return a1ToPy(contract);
  if (target === "java") return a1ToJava(contract);
  if (target === "rs") return a1ToRs(contract);
  if (target === "zig") return a1ToZig(contract);
  throw new Error("target '" + target + "' not wired (js | pl | c | go | py | java | rs | zig | sh | shir)");
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
  sh/go/py/c/pl/zsh/fish → A1 shIR via the UNIFIED frontend (busybox:
       all seven frontend libs in one merged binary, built on first use
       from www/bin/<frontend>/ with the in-browser go toolchain and
       cached in /tmp)
  A1 → js (sh2.* runtime) / pl / c / go / py / java / rs / zig / sh / shir

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
