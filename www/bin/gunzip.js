// gunzip v2 — decompress gzip files
//
// NAME
//      gunzip — decompress gzip files
//
// SYNOPSIS
//      gunzip [-k] file.gz...
//
// DESCRIPTION
//      gunzip decompresses each <file>.gz back to <file> and removes
//      the archive (like real gunzip); -k keeps it. With no file
//      arguments it acts as a filter: piped stdin is decompressed to
//      stdout, so 'echo hi | gzip | gunzip' round-trips. Engine:
//      pako in the browser, node:zlib in the CLI. Binary safe.
//
// OPTIONS
//      -k, --keep   keep the .gz input
//      -h, --help   show this help
//
// EXAMPLES
//      gunzip /home/notes.txt.gz    → /home/notes.txt
//      echo hi | gzip | gunzip      → hi

var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
var keep = false;
var files = [];
var i = 0;
while (i < args.length) {
  var a = args[i];
  if (a === "-h" || a === "--help") {
    console.log("gunzip — decompress gzip files");
    console.log("usage: gunzip [-k] file.gz... (no files: filter stdin → stdout)");
    console.log("example: gunzip /home/notes.txt.gz · echo hi | gzip | gunzip");
    return 0;
  }
  if (a === "-k" || a === "--keep") { keep = true; i++; continue; }
  if (a.charAt(0) === "-" && a.length > 1) {
    console.log("gunzip: invalid option -- '" + a + "'");
    return 2;
  }
  files.push(a);
  i++;
}

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
  engine = function (u8) { return window.pako.ungzip(u8); };
} else {
  var zlib = await import("node:zlib");
  engine = function (u8) { return new Uint8Array(zlib.gunzipSync(u8)); };
}

var hadError = false;
// stdin filter mode: no file arguments with piped input — decompress
// stdin to stdout, like real gunzip. Binary safe (pipe.in/pipe.out).
if (files.length === 0) {
  var pipeIn = (typeof pipe !== "undefined" && pipe) ? pipe.in : "";
  if (!pipeIn || pipeIn.length === 0) {
    console.log("gunzip: no files (gunzip [-k] file.gz...)");
    return 2;
  }
  var inputBytes = typeof pipeIn === "string" ? new TextEncoder().encode(pipeIn) : new Uint8Array(pipeIn);
  pipe.out(engine(inputBytes));
  return 0;
}
for (var f = 0; f < files.length; f++) {
  var srcPath = typeof fs._resolve === "function" ? fs._resolve(files[f]) : files[f];
  var input;
  try {
    var blob = await fs.readBlob(srcPath);
    input = new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    console.log("gunzip: " + files[f] + ": No such file or directory");
    hadError = true;
    continue;
  }
  try {
    var output = engine(input);
    var dest = files[f].slice(-3) === ".gz" ? files[f].slice(0, -3) : files[f] + ".out";
    var destPath = typeof fs._resolve === "function" ? fs._resolve(dest) : dest;
    await fs.writeBlob(destPath, new Blob([output], { type: "application/octet-stream" }));
    if (!keep) await fs.remove(srcPath);
    console.log("gunzip: " + files[f] + " → " + dest + " (" + output.length + " bytes)");
  } catch (e) {
    console.log("gunzip: " + files[f] + ": " + (e && e.message ? e.message : String(e)));
    hadError = true;
  }
}
return hadError ? 1 : 0;
