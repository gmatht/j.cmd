// lua v1 — Lua 5.4 interpreter via wasmoon (wasm, 0.3 MiB)
//
// NAME
//      lua — Lua 5.4 interpreter
//
// SYNOPSIS
//      lua [-e CODE] [script.lua] [args...]
//      echo 'print(6*7)' | lua
//
// DESCRIPTION
//      Runs Lua 5.4 compiled to WebAssembly (wasmoon). print and
//      io.write are routed to the shell; the trailing arguments
//      appear in the standard Lua arg table (arg[0] is the script name).
//      Scripts come from the shell's filesystem (lua script.lua) or
//      from a pipe (echo '...' | lua).
//
// OPTIONS
//      -e CODE      evaluate inline Lua code
//      -            read the script from stdin
//      -h, --help   show this help
//
// EXAMPLES
//      lua -e 'print(6*7)'
//      lua -e 'for i=1,3 do print(i) end'
//      echo 'print("hi")' | lua
//      lua /home/hello.lua world

var NL = String.fromCharCode(10);
var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

function usage() {
  console.log("lua — Lua 5.4 interpreter (wasmoon, wasm)");
  console.log("usage: lua [-e CODE] [script.lua] [args...]");
  console.log("       echo 'print(6*7)' | lua");
  console.log("");
  console.log("  -e CODE   evaluate inline Lua code");
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
if (args[0] === "-e") {
  codeArg = args[1] || "";
  restArgs = args.slice(2);
} else if (args[0] === "-") {
  scriptArg = "stdin.lua";
  restArgs = args.slice(1);
} else if (args[0] !== undefined) {
  scriptArg = args[0];
  restArgs = args.slice(1);
}
// bare lua with a piped script reads stdin (like real lua)
if (codeArg === null && scriptArg === null && stdin && stdin.trim()) {
  scriptArg = "stdin.lua";
  restArgs = [];
}
if (codeArg === null && scriptArg === null) {
  usage();
  return 2;
}

// ─── load the engine (browser: script tag → window.wasmoon ·
//     node: require/import from node_modules) ───
function loadScript(src) {
  return new Promise(function (resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) return resolve();
    var s = document.createElement("script");
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("failed to load " + src)); };
    document.head.appendChild(s);
  });
}
var LuaFactory = null;
try {
  if (isBrowser) {
    await loadScript("vendor/wasmoon.mjs");
    LuaFactory = window.wasmoon && window.wasmoon.LuaFactory;
    if (!LuaFactory) throw new Error("wasmoon did not load (window.wasmoon missing)");
  } else {
    var wasmoon = await import("wasmoon");
    LuaFactory = wasmoon.LuaFactory;
  }
} catch (e) {
  console.log("lua: cannot load wasmoon: " + (e && e.message ? e.message : String(e)));
  console.log("(install it with: npm install wasmoon)");
  return 1;
}

// ─── read the script (shell fs or stdin) ───
var scriptContent = null;
if (codeArg === null && scriptArg !== null && scriptArg !== "stdin.lua") {
  var resolved = typeof fs._resolve === "function" ? fs._resolve(scriptArg) : scriptArg;
  try {
    scriptContent = await fs.read(resolved);
    scriptArg = resolved;
  } catch (e) {
    console.log("lua: cannot open " + scriptArg + ": No such file or directory");
    return 2;
  }
} else if (scriptArg === "stdin.lua") {
  scriptContent = stdin || "";
}

// ─── start the engine ───
var outChunks = [];
var errChunks = [];
var lua;
try {
  var factory = new LuaFactory(isBrowser ? "vendor/wasmoon-glue.wasm" : undefined);
  lua = await factory.createEngine({ openStandardLibs: true });
  lua.global.set("__lua_out", function (s) { outChunks.push(String(s)); });
  // Route print and io.write to the shell: they normally go to the C
  // stdout (the browser console / Node stdout), which a command can't
  // capture. Replace them with a JS callback (string.char avoids
  // escapes: tab=9, newline=10).
  var shim = 'local __o=__lua_out; print=function(...) local t={} for i=1,select("#",...) do t[i]=tostring(select(i,...)) end __o(table.concat(t,string.char(9))..string.char(10)) end; io.write=function(...) local t={} for i=1,select("#",...) do t[i]=tostring(select(i,...)) end __o(table.concat(t,"")) end';
  lua.doStringSync(shim);
  // Standard Lua arg table: arg[0] = script name, arg[1..] = the
  // trailing arguments (wasmoon drops a 0 key from JS arrays, so
  // populate the table from a JS accessor instead).
  var argArr = [codeArg !== null ? "-e" : scriptArg].concat(restArgs);
  lua.global.set("__arg_get", function (idx) {
    var v = argArr[idx];
    return v === undefined ? null : v;
  });
  lua.doStringSync("arg={} for i=0," + String(argArr.length - 1) + " do arg[i]=__arg_get(i) end");
} catch (e) {
  console.log("lua: failed to start the interpreter: " + (e && e.message ? e.message : String(e)));
  return 1;
}

// ─── run (scripts run from their content — no file mount needed) ───
try {
  if (codeArg !== null) {
    await lua.doString(codeArg);
  } else {
    await lua.doString(scriptContent);
  }
} catch (e) {
  var msg = e && e.message ? e.message : String(e);
  if (msg.indexOf("lua:") !== 0) msg = "lua: " + msg;
  console.log(msg);
  return 1;
}

// ─── emit captured output ───
function emit(text) {
  var s = String(text);
  if (!s) return;
  var lines = s.split(NL);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (var k = 0; k < lines.length; k++) console.log(lines[k]);
}
emit(outChunks.join(""));
emit(errChunks.join(""));
return 0;
