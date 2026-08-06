// gzip v2 — compress files (gzip format)
//
// NAME
//      gzip — compress files (gzip format)
//
// SYNOPSIS
//      gzip [-d] [-k] file...
//
// DESCRIPTION
//      gzip compresses each file to <file>.gz and removes the
//      original (like real gzip); -k keeps it. -d decompresses
//      <file>.gz back to <file>. With no file arguments it acts as
//      a filter: piped stdin is compressed (or decompressed with -d)
//      to stdout, so 'echo hi | gzip | gunzip' round-trips. Engine:
//      pako in the browser, node:zlib in the CLI. Binary safe
//      (readBlob/writeBlob, raw pipe bytes).
//
// OPTIONS
//      -d, --decompress  decompress (same as gunzip)
//      -k, --keep        keep the input file
//      -h, --help        show this help
//
// EXAMPLES
//      gzip /home/notes.txt          → /home/notes.txt.gz
//      gzip -d /home/notes.txt.gz    → /home/notes.txt
//      gzip -k -d /home/notes.txt.gz
//      echo hi | gzip | gunzip       → hi

var NL = String.fromCharCode(10);
var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
var decompress = false;
var keep = false;
var files = [];
var i = 0;
while (i < args.length) {
  var a = args[i];
  if (a === "-h" || a === "--help") {
    console.log("gzip — compress files (gzip format)");
    console.log("usage: gzip [-d] [-k] file... (no files: filter stdin → stdout)");
    console.log("example: gzip /home/notes.txt · gzip -d /home/notes.txt.gz · echo hi | gzip | gunzip");
    return 0;
  }
  if (a === "-d" || a === "--decompress") { decompress = true; i++; continue; }
  if (a === "-k" || a === "--keep") { keep = true; i++; continue; }
  if (a.charAt(0) === "-" && a.length > 1) {
    console.log("gzip: invalid option -- '" + a + "'");
    return 2;
  }
  files.push(a);
  i++;
}

// ─── engine: pako (browser) · node:zlib (CLI) ───
var engine = null;
if (isBrowser) {
  await new Promise(function (resolve, reject) {
    var src = "vendor/pako.min.js";
    if (window.pako) return resolve();
    if (document.querySelector('script[src="' + src + '"]')) return resolve();
    var s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = function () { reject(new Error("failed to load " + src)); };
    document.head.appendChild(s);
  });
  engine = {
    compress: function (u8) { return window.pako.gzip(u8); },
    decompress: function (u8) { return window.pako.ungzip(u8); },
  };
} else {
  var zlib = await import("node:zlib");
  engine = {
    compress: function (u8) { return new Uint8Array(zlib.gzipSync(u8)); },
    decompress: function (u8) { return new Uint8Array(zlib.gunzipSync(u8)); },
  };
}

var hadError = false;
// stdin filter mode: no file arguments with piped input — compress
// stdin to stdout (or decompress with -d), like real gzip. Binary
// safe: pipe.in is the raw bytes, pipe.out emits raw bytes.
if (files.length === 0) {
  var pipeIn = (typeof pipe !== "undefined" && pipe) ? pipe.in : "";
  if (!pipeIn || pipeIn.length === 0) {
    console.log("gzip: no files (gzip [-d] [-k] file...)");
    return 2;
  }
  var inputBytes = typeof pipeIn === "string" ? new TextEncoder().encode(pipeIn) : new Uint8Array(pipeIn);
  var filtered = decompress ? engine.decompress(inputBytes) : engine.compress(inputBytes);
  pipe.out(filtered);
  return 0;
}
for (var f = 0; f < files.length; f++) {
  var srcPath = typeof fs._resolve === "function" ? fs._resolve(files[f]) : files[f];
  var input;
  try {
    var blob = await fs.readBlob(srcPath);
    input = new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    console.log("gzip: " + files[f] + ": No such file or directory");
    hadError = true;
    continue;
  }
  try {
    var output;
    var dest;
    if (decompress) {
      output = engine.decompress(input);
      dest = files[f].slice(-3) === ".gz" ? files[f].slice(0, -3) : files[f] + ".out";
    } else {
      output = engine.compress(input);
      dest = files[f] + ".gz";
    }
    var destPath = typeof fs._resolve === "function" ? fs._resolve(dest) : dest;
    var mime = decompress ? "application/octet-stream" : "application/gzip";
    await fs.writeBlob(destPath, new Blob([output], { type: mime }));
    if (!keep) await fs.remove(srcPath);
    console.log("gzip: " + files[f] + " → " + dest + " (" + output.length + " bytes)");
  } catch (e) {
    console.log("gzip: " + files[f] + ": " + (e && e.message ? e.message : String(e)));
    hadError = true;
  }
}
return hadError ? 1 : 0;
