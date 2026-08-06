// perl v1 — Perl 5 interpreter via @6over3/zeroperl-ts (zeroperl, wasm)
//
// NAME
//      perl — Perl 5 interpreter
//
// SYNOPSIS
//      perl [-e CODE] [script.pl] [args...]
//      echo 'print 6*7' | perl
//
// DESCRIPTION
//      Runs Perl 5.42 compiled to WebAssembly (the zeroperl project,
//      via the @6over3/zeroperl-ts npm package). The script is
//      registered into the interpreter's virtual filesystem; @ARGV is
//      set from the trailing arguments, and stdout/stderr flow to the
//      shell. Scripts are read from the shell's filesystem (perl
//      script.pl) or from a pipe (echo '...' | perl).
//
// OPTIONS
//      -e CODE      evaluate inline Perl code
//      -E CODE      same as -e (modern Perl features)
//      -            read the script from stdin
//      -h, --help   show this help
//
// EXAMPLES
//      perl -e 'print 6*7'
//      perl -e 'print join(",", @ARGV)' a b c
//      echo 'print "hi"' | perl
//      perl /home/hello.pl hello world

var NL = String.fromCharCode(10);
var LIB = "@6over3/zeroperl-ts";
var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

function usage() {
  console.log("perl — Perl 5 interpreter (zeroperl, wasm)");
  console.log("usage: perl [-e CODE] [script.pl] [args...]");
  console.log("       echo 'print 6*7' | perl");
  console.log("");
  console.log("  -e CODE   evaluate inline Perl code");
  console.log("  -E CODE   same as -e (modern Perl features)");
  console.log("  -         read the script from stdin");
  console.log("  -h        this help");
}

// ─── parse arguments ───
var codeArg = null;
var scriptArg = null;
var restArgs = [];
if (args[0] === "-h" || args[0] === "--help") {
  usage();
  return 0;
}
var isE = args[0] === "-E";
if (args[0] === "-e" || isE) {
  codeArg = args[1] || "";
  if (isE) codeArg = 'use feature ":5.40";' + NL + codeArg;
  restArgs = args.slice(2);
} else if (args[0] === "-") {
  scriptArg = "stdin.pl";
  restArgs = args.slice(1);
} else if (args[0] !== undefined) {
  scriptArg = args[0];
  restArgs = args.slice(1);
}
// bare perl with a piped script reads the program from stdin
// (real perl behaviour); with empty stdin it shows usage.
if (codeArg === null && scriptArg === null && stdin && stdin.trim()) {
  scriptArg = "stdin.pl";
  restArgs = [];
}
if (codeArg === null && scriptArg === null) {
  usage();
  return 2;
}

// ─── load the library (browser: importmap · node: node_modules) ───
var mod;
try {
  mod = await import(LIB);
} catch (e) {
  console.log("perl: cannot load " + LIB + ": " + (e && e.message ? e.message : String(e)));
  console.log("(install it with: npm install @6over3/zeroperl-ts)");
  return 1;
}

// ─── read the script (file from the shell's fs, or stdin) ───
var scriptContent = null;
if (codeArg === null && scriptArg !== null && scriptArg !== "stdin.pl") {
  var resolved = typeof fs._resolve === "function" ? fs._resolve(scriptArg) : scriptArg;
  try {
    scriptContent = await fs.read(resolved);
    scriptArg = resolved;
  } catch (e) {
    console.log("perl: Can't open " + scriptArg + ": No such file or directory");
    return 2;
  }
} else if (scriptArg === "stdin.pl") {
  scriptContent = stdin || "";
}

// ─── start the interpreter ───
var outChunks = [];
var errChunks = [];
function dec(chunk) {
  if (typeof chunk === "string") return chunk;
  return new TextDecoder().decode(chunk);
}
var memfs = null;
try {
  if (scriptContent !== null && scriptArg !== null) {
    memfs = new mod.MemoryFileSystem();
    memfs.addFile(scriptArg, scriptContent);
  }
} catch (e) {
  console.log("perl: cannot register script: " + (e && e.message ? e.message : String(e)));
  return 1;
}

var perl;
try {
  perl = await mod.ZeroPerl.create({
    env: env || {},
    fileSystem: memfs,
    stdout: function (d) { outChunks.push(dec(d)); },
    stderr: function (d) { errChunks.push(dec(d)); },
    fetch: isBrowser
      ? function () { return fetch("vendor/zeroperl.wasm"); }
      : undefined,
  });
} catch (e) {
  console.log("perl: failed to start the interpreter: " + (e && e.message ? e.message : String(e)));
  return 1;
}

// ─── run ───
var result;
try {
  if (codeArg !== null) {
    result = await perl.eval(codeArg, restArgs);
  } else {
    result = await perl.runFile(scriptArg, restArgs);
  }
} catch (e) {
  try { perl.flush(); } catch (e2) {}
  try { perl.shutdown(); } catch (e3) {}
  console.log("perl: " + (e && e.message ? e.message : String(e)));
  return 1;
}
try { perl.flush(); } catch (e4) {}
try { perl.shutdown(); } catch (e5) {}

// ─── emit captured output (shell streams are text) ───
function emit(text) {
  var s = String(text);
  if (!s) return;
  var lines = s.split(NL);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (var k = 0; k < lines.length; k++) console.log(lines[k]);
}
emit(outChunks.join(""));
emit(errChunks.join(""));
var exitCode = (result && result.exitCode) || 0;
if (!result || !result.success) {
  if (result && result.error) emit(String(result.error));
  return exitCode > 0 ? exitCode : 1;
}
return exitCode > 0 ? exitCode : 0;
