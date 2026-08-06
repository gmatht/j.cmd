// tar v1 — create, list and extract tar archives (ustar)
//
// NAME
//      tar — create, list and extract tar archives
//
// SYNOPSIS
//      tar -cf ARCHIVE <file|dir>...   create (dirs recursed)
//      tar -tf ARCHIVE                 list entries
//      tar -xf ARCHIVE                 extract (into cwd or -C DIR)
//      tar -z                          gzip the archive (tar.gz)
//
// DESCRIPTION
//      tar packs files and directories into a POSIX ustar archive.
//      Directories are recursed; remote/device mounts (/pc /dev /proc
//      /http /github /gitlab /git /mount) are skipped when walking.
//      With -z the archive is gzip-compressed (pako/node:zlib). When
//      the destination is on /pc, the archive is STREAMED through
//      StreamSaver as it is built — nothing is materialized in memory.
//
// OPTIONS
//      -cf FILE ...   create
//      -tf FILE       list
//      -xf FILE       extract
//      -C DIR         extract into DIR
//      -z             gzip (create) / gunzip (extract)
//      -h, --help     show this help
//
// EXAMPLES
//      tar -cf /home/backup.tar /home/notes.txt /home/photos/
//      tar -czf /pc/backup.tgz /          (streams the download)
//      tar -xf /home/backup.tar -C /tmp

var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
var BLOCK = 512;
var SKIP = ["/pc", "/dev", "/proc", "/http", "/github", "/gitlab", "/git", "/mount", "/commands"];
var enc = new TextEncoder();
var dec = new TextDecoder();

function usage() {
  console.log("tar — create, list and extract tar archives (ustar)");
  console.log("usage: tar -cf ARCHIVE file... · tar -tf ARCHIVE · tar -xf ARCHIVE [-C DIR] [-z]");
  console.log("example: tar -czf /pc/backup.tgz /");
}

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") { usage(); return args.length ? 0 : 2; }

var mode = null;      // "c" | "t" | "x"
var gzip = false;
var archive = null;
var extractDir = null;
var paths = [];
var i = 0;
while (i < args.length) {
  var a = args[i];
  if (a.charAt(0) === "-" && a.length > 1 && a !== "-C") {
    for (var k = 1; k < a.length; k++) {
      var c = a.charAt(k);
      if (c === "c" || c === "t" || c === "x") mode = c;
      else if (c === "z") gzip = true;
      else if (c === "f") { archive = args[i + 1]; i++; }
      else if (c === "C") { extractDir = args[i + 1]; i++; }
      else {
        console.log("tar: invalid option -- '" + c + "'");
        return 2;
      }
    }
    i++;
    continue;
  }
  if (a === "-C") { extractDir = args[i + 1]; i += 2; continue; }
  paths.push(a);
  i++;
}
if (!mode || !archive) { usage(); return 2; }
if (mode === "c" && paths.length === 0) { console.log("tar: no files to archive"); return 2; }
var outPath = typeof fs._resolve === "function" ? fs._resolve(archive) : archive;

// ─── engine ────────────────────────────────────────────────────
var gz = null;
if (gzip) {
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
    gz = {
      gzip: function (u8) { return window.pako.gzip(u8); },
      gunzip: function (u8) { return window.pako.ungzip(u8); },
    };
  } else {
    var nz = await import("node:zlib");
    gz = {
      gzip: function (u8) { return new Uint8Array(nz.gzipSync(u8)); },
      gunzip: function (u8) { return new Uint8Array(nz.gunzipSync(u8)); },
    };
  }
}

// ─── ustar helpers ──────────────────────────────────────────────
function octal(v, len) {
  var s = v.toString(8);
  while (s.length < len - 1) s = "0" + s;
  return s + String.fromCharCode(0);
}
function asciiInto(u8, off, len, s) {
  var b = enc.encode(s);
  for (var i = 0; i < len; i++) u8[off + i] = i < b.length ? b[i] : 0;
}
function headerFor(entry) {
  var h = new Uint8Array(BLOCK);
  asciiInto(h, 0, 100, entry.name);
  asciiInto(h, 100, 8, octal(entry.mode || 420, 8));   // 0644
  asciiInto(h, 108, 8, octal(0, 8));
  asciiInto(h, 116, 8, octal(0, 8));
  asciiInto(h, 124, 12, octal(entry.size || 0, 12));
  asciiInto(h, 136, 12, octal(Math.floor((entry.mtime || Date.now()) / 1000), 12));
  h[156] = entry.isDir ? 53 : 48;   // '5' dir, '0' file
  // magic + version: "ustar" NUL "00"
  var mag = enc.encode("ustar");
  for (var m = 0; m < 5; m++) h[257 + m] = mag[m];
  h[262] = 0; h[263] = 48; h[264] = 48;
  asciiInto(h, 265, 32, "jtsh");
  // checksum: sum with the field as 8 spaces, then 6 octal digits + NUL + space
  for (var sp = 148; sp < 156; sp++) h[sp] = 32;
  var chk = 0;
  for (var i = 0; i < BLOCK; i++) chk += h[i];
  var chkStr = chk.toString(8);
  while (chkStr.length < 6) chkStr = "0" + chkStr;
  asciiInto(h, 148, 8, chkStr + String.fromCharCode(0) + " ");
  return h;
}

function baseName(p) {
  var s = String(p);
  while (s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  var idx = s.lastIndexOf("/");
  return idx === -1 ? s : s.slice(idx + 1);
}

function skipped(p) {
  for (var s = 0; s < SKIP.length; s++) if (p === SKIP[s] || p.indexOf(SKIP[s] + "/") === 0) return true;
  return false;
}

// ─── create ─────────────────────────────────────────────────────
function* tarChunks(entries) {
  for (var e = 0; e < entries.length; e++) {
    var ent = entries[e];
    var h = headerFor(ent);
    yield h;
    if (!ent.isDir && ent.data && ent.data.length) {
      yield ent.data;
      var pad = BLOCK - (ent.data.length % BLOCK);
      if (pad !== BLOCK) yield new Uint8Array(pad);
    }
  }
  yield new Uint8Array(BLOCK);
  yield new Uint8Array(BLOCK);
}

async function createTar() {
  var entries = [];
  async function walk(dir, name) {
    var list;
    try { list = await fs.list(dir); } catch { return; }
    var sub = [];
    for (var k = 0; k < list.length; k++) {
      var e = list[k];
      var isDir = e.charAt(e.length - 1) === "/";
      var n = isDir ? e.slice(0, -1) : e;
      var full = dir === "/" ? "/" + n : dir + "/" + n;
      if (skipped(full)) continue;
      var tarName = name ? name + "/" + n : baseName(n);
      if (isDir) {
        entries.push({ name: tarName + "/", isDir: true, mode: 493, mtime: Date.now(), size: 0 });
        await walk(full, tarName);
      } else {
        var blob = await fs.readBlob(full);
        var data = new Uint8Array(await blob.arrayBuffer());
        entries.push({ name: tarName, isDir: false, mode: 420, mtime: Date.now(), size: data.length, data: data });
      }
    }
  }
  for (var p = 0; p < paths.length; p++) {
    var resolved = typeof fs._resolve === "function" ? fs._resolve(paths[p]) : paths[p];
    if (skipped(resolved)) { console.log("tar: skipping " + paths[p] + " (mount excluded)"); continue; }
    var st;
    try { st = await fs.stat(resolved); } catch { st = null; }
    if (!st) { console.log("tar: " + paths[p] + ": No such file or directory"); return 1; }
    var base = baseName(paths[p]);
    if (st.type === "dir") {
      entries.push({ name: base + "/", isDir: true, mode: 493, mtime: Date.now(), size: 0 });
      await walk(resolved, base);
    } else {
      var blob2 = await fs.readBlob(resolved);
      var data2 = new Uint8Array(await blob2.arrayBuffer());
      entries.push({ name: base, isDir: false, mode: 420, mtime: Date.now(), size: data2.length, data: data2 });
    }
  }
  if (entries.length === 0) { console.log("tar: nothing to archive"); return 1; }

  // chunks → (optionally gzip) → stream to /pc or build in memory
  function* rawChunks() { yield* tarChunks(entries); }
  var bytesWritten = await writeOut(rawChunks);
  console.log("tar: " + entries.length + " entr" + (entries.length === 1 ? "y" : "ies") +
    " → " + archive + " (" + bytesWritten + " bytes" + (gzip ? ", gzip" : "") + ")");
  return 0;
}

async function writeOut(chunksFn) {
  var gzipper = null;
  if (gzip) {
    if (isBrowser) gzipper = new window.pako.Deflate({ gzip: true });
  }
  var wrote = 0;
  // Try streaming (DownloadFS via StreamSaver); fall back to in-memory.
  try {
    var ws = await fs.writeStream(outPath);
    var writer = ws.getWriter();
    for (var chunk of chunksFn()) {
      if (gzipper) {
        gzipper.push(chunk, false);
        if (gzipper.result && gzipper.result.length) {
          await writer.write(gzipper.result);
          wrote += gzipper.result.length;
          gzipper.result = null;
        }
      } else {
        await writer.write(chunk);
        wrote += chunk.length;
      }
    }
    if (gzipper) {
      gzipper.push(new Uint8Array(0), true);
      if (gzipper.result && gzipper.result.length) {
        await writer.write(gzipper.result);
        wrote += gzipper.result.length;
      }
    }
    await writer.close();
    return wrote;
  } catch (eStream) {
    // in-memory fallback
    var parts = [];
    var total = 0;
    for (var chunk2 of chunksFn()) {
      if (gzipper) {
        gzipper.push(chunk2, false);
        if (gzipper.result && gzipper.result.length) { parts.push(gzipper.result); total += gzipper.result.length; gzipper.result = null; }
      } else { parts.push(chunk2); total += chunk2.length; }
    }
    if (gzipper) {
      gzipper.push(new Uint8Array(0), true);
      if (gzipper.result && gzipper.result.length) { parts.push(gzipper.result); total += gzipper.result.length; }
    }
    var all = new Uint8Array(total);
    var off = 0;
    for (var p = 0; p < parts.length; p++) { all.set(parts[p], off); off += parts[p].length; }
    var finalBytes = all;
    var mime = "application/x-tar";
    if (gzip && !gzipper) {          // CLI: compress the assembled tar
      finalBytes = gz.gzip(all);
      mime = "application/gzip";
    } else if (gzipper) {
      mime = "application/gzip";
    }
    await fs.writeBlob(outPath, new Blob([finalBytes], { type: mime }));
    return finalBytes.length;
  }
}

// ─── list ───────────────────────────────────────────────────────
async function readRawArchive() {
  var blob = await fs.readBlob(outPath);
  var u8 = new Uint8Array(await blob.arrayBuffer());
  return gzip ? gz.gunzip(u8) : u8;
}

async function listTar() {
  var bytes = await readRawArchive();
  var pos = 0;
  var count = 0;
  while (pos + BLOCK <= bytes.length) {
    var block = bytes.subarray(pos, pos + BLOCK);
    if (isZeroBlock(block)) break;
    var size = parseOctal(bytes, pos + 124, 12);
    var name = readName(bytes, pos, 100);
    var typeflag = bytes[pos + 156];
    if (size === null) break;
    if (typeflag === 53 || typeflag === 48) {
      console.log((typeflag === 53 ? "d" : "-") + " " + String(size).padStart(10) + "  " + name);
      count++;
    }
    pos += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  console.log("tar: " + count + " entr" + (count === 1 ? "y" : "ies") + " in " + archive);
  return 0;
}

// ─── extract ────────────────────────────────────────────────────
async function extractTar() {
  var bytes = await readRawArchive();
  var base = extractDir ? (typeof fs._resolve === "function" ? fs._resolve(extractDir) : extractDir) : (fs.cwd || "/home");
  var pos = 0;
  var count = 0;
  var hadError = false;
  while (pos + BLOCK <= bytes.length) {
    var block = bytes.subarray(pos, pos + BLOCK);
    if (isZeroBlock(block)) break;
    var size = parseOctal(bytes, pos + 124, 12);
    var name = readName(bytes, pos, 100);
    var typeflag = bytes[pos + 156];
    if (size === null) break;
    var dest = base === "/" ? "/" + name : base + "/" + name;
    var dataStart = pos + BLOCK;
    var dataEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (dataEnd > bytes.length) break;
    try {
      if (typeflag === 53) {
        await fs.mkdir(dest);
        count++;
      } else if (typeflag === 48 || typeflag === 0) {
        var data = bytes.subarray(dataStart, dataStart + size);
        await fs.writeBlob(dest, new Blob([data], { type: "application/octet-stream" }));
        console.log("  " + name);
        count++;
      }
    } catch (e) {
      console.log("tar: " + name + ": " + (e && e.message ? e.message : String(e)));
      hadError = true;
    }
    pos = dataEnd;
  }
  console.log("tar: extracted " + count + " entr" + (count === 1 ? "y" : "ies") + " to " + base);
  return hadError ? 1 : 0;
}

function isZeroBlock(b) {
  for (var i = 0; i < BLOCK; i++) if (b[i] !== 0) return false;
  return true;
}
function parseOctal(bytes, off, len) {
  var s = "";
  for (var i = off; i < off + len; i++) {
    if (bytes[i] === 0) break;
    s += String.fromCharCode(bytes[i]);
  }
  s = s.trim();
  if (!s) return null;
  var v = parseInt(s, 8);
  return isFinite(v) ? v : null;
}
function readName(bytes, off, len) {
  var end = off;
  while (end < off + len && bytes[end] !== 0) end++;
  return dec.decode(bytes.subarray(off, end));
}

if (mode === "c") return await createTar();
if (mode === "t") return await listTar();
return await extractTar();
