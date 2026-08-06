// diff v1 — compare two files (wasm-diff engine, vendored wasm)
//
// NAME
//      diff — compare two files
//
// SYNOPSIS
//      diff <file1> <file2>
//
// DESCRIPTION
//      Compares two files and prints the differences, prefixed like a
//      unified diff (space = context, - = removed, + = added). The
//      engine is wasm-diff (the diff crate compiled to WebAssembly,
//      vendored as wasm-bin/wasm-diff.wasm) — it finds differences at
//      character granularity, so intra-line changes appear as fine
//      insert/delete chunks rather than whole-line replacements.
//
//      Exit status: 0 if identical, 1 if different, 2 on error (like
//      the real diff).
//
// EXAMPLES
//      diff /home/a.txt /home/b.txt
//      diff README.md README.md.bak

var NL = String.fromCharCode(10);
var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log("diff — compare two files (wasm-diff engine, vendored wasm)");
  console.log("usage: diff <file1> <file2>");
  console.log("exit: 0 identical · 1 different · 2 error (like real diff)");
  console.log("example: diff /home/a.txt /home/b.txt");
  return args.length === 0 ? 2 : 0;
}
if (args.length !== 2) {
  console.log("diff: expected two files, got " + args.length);
  console.log("usage: diff <file1> <file2>");
  return 2;
}
var f1 = args[0];
var f2 = args[1];

function readPath(p) {
  var resolved = typeof fs._resolve === "function" ? fs._resolve(p) : p;
  return fs.read(resolved);
}
var a;
var b;
try { a = await readPath(f1); } catch (e) {
  console.log("diff: " + f1 + ": No such file or directory");
  return 2;
}
try { b = await readPath(f2); } catch (e) {
  console.log("diff: " + f2 + ": No such file or directory");
  return 2;
}

// ─── load the vendored wasm (browser: fetch · node: read from disk) ───
var bytes;
try {
  if (isBrowser) {
    var resp = await fetch("wasm-bin/wasm-diff.wasm");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    bytes = await resp.arrayBuffer();
  } else {
    var fsp = await import("node:fs/promises");
    try {
      bytes = await fsp.readFile(process.cwd() + "/www/wasm-bin/wasm-diff.wasm");
    } catch (e2) {
      bytes = await fsp.readFile(process.cwd() + "/wasm-bin/wasm-diff.wasm");
    }
  }
} catch (e) {
  console.log("diff: cannot load wasm-bin/wasm-diff.wasm: " + (e && e.message ? e.message : String(e)));
  console.log("(npm install wasm-diff, then copy node_modules/wasm-diff/wasm_diff_bg.wasm to www/wasm-bin/wasm-diff.wasm)");
  return 1;
}

// ─── instantiate: the wasm imports just __wbindgen_json_parse ───
var heap = [];
var dec = new TextDecoder();
var enc = new TextEncoder();
var wasm;
var instance;
try {
  // instantiate returns { module, instance } — unwrap it (a variable
  // named instance holding the whole result would have no .exports)
  instance = (await WebAssembly.instantiate(bytes, {
    "./wasm_diff.js": {
      __wbindgen_json_parse: function (ptr, len) {
        var s = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
        heap.push(JSON.parse(s));
        return heap.length - 1;
      },
    },
  })).instance;
  wasm = instance.exports;
} catch (e) {
  console.log("diff: failed to start the wasm engine: " + (e && e.message ? e.message : String(e)));
  return 1;
}
function getMem() { return new Uint8Array(wasm.memory.buffer); }
function passString(s) {
  var b = enc.encode(s);
  var p = wasm.__wbindgen_malloc(b.length, 1);
  getMem().set(b, p);
  return { p: p, l: b.length };
}
function runDiff(x, y) {
  var A = passString(x);
  var B = passString(y);
  var idx = wasm.diff_text(A.p, A.l, B.p, B.l);
  var res = heap[idx];
  heap[idx] = undefined;
  return res;
}

// ─── render {Equal|Delete|Insert: text} ops as a marked diff ───
var ops;
try { ops = runDiff(a, b); } catch (e) {
  console.log("diff: engine error: " + (e && e.message ? e.message : String(e)));
  return 1;
}
if (!Array.isArray(ops) || ops.length === 0) return 0;  // identical

// A chunk may span several lines — every line gets the tag prefix.
function prefixed(tag, text) {
  var parts = String(text).split(NL);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  var s = "";
  for (var k = 0; k < parts.length; k++) s += tag + parts[k] + NL;
  return s;
}
var out = "--- " + f1 + NL + "+++ " + f2 + NL;
var changed = false;
for (var i = 0; i < ops.length; i++) {
  var op = ops[i];
  if (op.Equal !== undefined) {
    out += prefixed(" ", op.Equal);
  } else if (op.Delete !== undefined) {
    out += prefixed("-", op.Delete);
    changed = true;
  } else {
    out += prefixed("+", op.Insert);
    changed = true;
  }
}
if (!changed) return 0;
if (out.charAt(out.length - 1) === NL) out = out.slice(0, -1);
console.log(out);
return 1;
