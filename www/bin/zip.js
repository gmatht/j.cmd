// zip v1 — package files into a ZIP archive
//
// NAME
//      zip — package files into a ZIP archive
//
// SYNOPSIS
//      zip <archive.zip> <file|dir>...   create (dirs recursed)
//      zip -l <archive.zip>              list entries
//      zip -x <archive.zip>              extract into the cwd
//      zip -h                            help
//
// DESCRIPTION
//      zip builds a standard ZIP archive (deflate, with a stored
//      fallback for incompressible data). Directories are recursed.
//      Engine: pako in the browser, node:zlib in the CLI. Binary safe
//      (readBlob/writeBlob).
//
// EXAMPLES
//      zip /home/backup.zip /home/notes.txt /home/photos/
//      zip -l /home/backup.zip
//      zip -x /home/backup.zip

var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
var enc = new TextEncoder();
var dec = new TextDecoder();
var LOCAL_SIG = 0x04034b50;
var CENTRAL_SIG = 0x02014b50;
var EOCD_SIG = 0x06054b50;

// ─── CRC32 ─────────────────────────────────────────────────────
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  var c = 0xffffffff;
  for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function rdU32(u8, off) { return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0; }
function rdU16(u8, off) { return (u8[off] | (u8[off + 1] << 8)) & 0xffff; }
function dosTime(d) { return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff; }
function dosDate(d) { return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff; }

// ─── engine ────────────────────────────────────────────────────
var zlibApi = null;
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
  zlibApi = {
    deflateRaw: function (u8) { return window.pako.deflateRaw(u8); },
    inflateRaw: function (u8) { return window.pako.inflateRaw(u8); },
  };
} else {
  var nz = await import("node:zlib");
  zlibApi = {
    deflateRaw: function (u8) { return new Uint8Array(nz.deflateRawSync(u8)); },
    inflateRaw: function (u8) { return new Uint8Array(nz.inflateRawSync(u8)); },
  };
}

function baseName(p) {
  var s = String(p);
  while (s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  var idx = s.lastIndexOf("/");
  return idx === -1 ? s : s.slice(idx + 1);
}

function usage() {
  console.log("zip — package files into a ZIP archive");
  console.log("usage: zip <archive.zip> <file|dir>... · zip -l <archive.zip> · zip -x <archive.zip>");
  console.log("example: zip /home/backup.zip /home/notes.txt /home/photos/");
}

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") { usage(); return args.length ? 0 : 2; }
if (args[0] === "-l" || args[0] === "--list") { return await listArchive(args[1]); }
if (args[0] === "-x" || args[0] === "--extract") { return await extractArchive(args[1]); }
if (args[0].charAt(0) === "-") { console.log("zip: invalid option -- '" + args[0] + "'"); return 2; }
if (args.length < 2) { usage(); return 2; }
return await createArchive(args[0], args.slice(1));

// ─── collect entries (dirs recursed) ───────────────────────────
async function collectEntries(paths) {
  var entries = [];
  async function walk(dir, name) {
    var list = await fs.list(dir);
    var sub = [];
    for (var k = 0; k < list.length; k++) {
      var e = list[k];
      var isDir = e.charAt(e.length - 1) === "/";
      var n = isDir ? e.slice(0, -1) : e;
      var full = dir === "/" ? "/" + n : dir + "/" + n;
      var zipName = name ? name + "/" + n : n;
      if (isDir) {
        entries.push({ name: zipName + "/", isDir: true, data: null });
        await walk(full, zipName);
      } else {
        var blob = await fs.readBlob(full);
        var data = new Uint8Array(await blob.arrayBuffer());
        entries.push({ name: zipName, isDir: false, data: data });
      }
    }
  }
  for (var p = 0; p < paths.length; p++) {
    var resolved = typeof fs._resolve === "function" ? fs._resolve(paths[p]) : paths[p];
    var st;
    try { st = await fs.stat(resolved); } catch { st = null; }
    if (!st) {
      console.log("zip: " + paths[p] + ": No such file or directory");
      return null;
    }
    if (st.type === "dir") {
      entries.push({ name: baseName(paths[p]) + "/", isDir: true, data: null });
      await walk(resolved, baseName(paths[p]));
    } else {
      var blob2 = await fs.readBlob(resolved);
      entries.push({ name: baseName(paths[p]), isDir: false, data: new Uint8Array(await blob2.arrayBuffer()) });
    }
  }
  return entries;
}

async function createArchive(archive, paths) {
  var entries = await collectEntries(paths);
  if (!entries) return 1;

  var localOffsets = [];
  var central = [];
  var chunks = [];
  var total = 0;
  var now = new Date();
  var dt = dosTime(now), dd = dosDate(now);

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var nameBytes = enc.encode(e.name);
    var data = e.data || new Uint8Array(0);
    var crc = e.isDir ? 0 : crc32(data);
    var comp = e.isDir ? new Uint8Array(0) : zlibApi.deflateRaw(data);
    var method = (!e.isDir && comp.length < data.length) ? 8 : 0;
    if (method === 0) comp = data;

    // local file header
    var lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, LOCAL_SIG, true);
    lh.setUint16(4, 20, true);      // version needed
    lh.setUint16(6, 0, true);       // flags
    lh.setUint16(8, method, true);
    lh.setUint16(10, dt, true);
    lh.setUint16(12, dd, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);      // extra len
    localOffsets.push(total);
    chunks.push(new Uint8Array(lh.buffer), nameBytes, comp);
    total += 30 + nameBytes.length + comp.length;

    // central directory entry
    var ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, CENTRAL_SIG, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, dt, true);
    ch.setUint16(14, dd, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, localOffsets[i], true);
    central.push({ bytes: new Uint8Array(ch.buffer), name: nameBytes });
  }

  var cdStart = total;
  var cdSize = 0;
  for (var c = 0; c < central.length; c++) {
    chunks.push(central[c].bytes, central[c].name);
    cdSize += 46 + central[c].name.length;
  }
  var eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, EOCD_SIG, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd.buffer));

  var totalBytes = 0;
  for (var b = 0; b < chunks.length; b++) totalBytes += chunks[b].length;
  var out = new Uint8Array(totalBytes);
  var off = 0;
  for (var b2 = 0; b2 < chunks.length; b2++) { out.set(chunks[b2], off); off += chunks[b2].length; }

  var dest = typeof fs._resolve === "function" ? fs._resolve(archive) : archive;
  await fs.writeBlob(dest, new Blob([out], { type: "application/zip" }));
  console.log("zip: " + entries.length + " entr" + (entries.length === 1 ? "y" : "ies") + " → " + archive + " (" + out.length + " bytes)");
  return 0;
}

async function listArchive(archive) {
  var bytes = await readArchive(archive);
  if (!bytes) return 1;
  var eocd = findEocd(bytes);
  if (!eocd) { console.log("zip: " + archive + ": not a zip archive"); return 1; }
  var count = rdU16(bytes, eocd + 10);
  var cdOff = rdU32(bytes, eocd + 16);
  var pos = cdOff;
  for (var i = 0; i < count; i++) {
    if (rdU32(bytes, pos) !== CENTRAL_SIG) break;
    var nameLen = rdU16(bytes, pos + 28);
    var compSize = rdU32(bytes, pos + 20);
    var name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    console.log(String(compSize).padStart(10) + "  " + name);
    pos += 46 + nameLen + rdU16(bytes, pos + 30) + rdU16(bytes, pos + 32);
  }
  return 0;
}

async function extractArchive(archive) {
  var bytes = await readArchive(archive);
  if (!bytes) return 1;
  var eocd = findEocd(bytes);
  if (!eocd) { console.log("zip: " + archive + ": not a zip archive"); return 1; }
  var count = rdU16(bytes, eocd + 10);
  var cdOff = rdU32(bytes, eocd + 16);
  var pos = cdOff;
  var hadError = false;
  for (var i = 0; i < count; i++) {
    if (rdU32(bytes, pos) !== CENTRAL_SIG) break;
    var method = rdU16(bytes, pos + 10);
    var compSize = rdU32(bytes, pos + 20);
    var uncompSize = rdU32(bytes, pos + 24);
    var nameLen = rdU16(bytes, pos + 28);
    var localOff = rdU32(bytes, pos + 42);
    var name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + rdU16(bytes, pos + 30) + rdU16(bytes, pos + 32);
    try {
      if (name.charAt(name.length - 1) === "/") {
        await fs.mkdir(name);
        continue;
      }
      var dataOff = localOff + 30 + rdU16(bytes, localOff + 26) + rdU16(bytes, localOff + 28);
      var comp = bytes.subarray(dataOff, dataOff + compSize);
      var data = method === 8 ? zlibApi.inflateRaw(comp) : comp;
      await fs.writeBlob(name, new Blob([data], { type: "application/octet-stream" }));
      console.log("  " + name);
    } catch (e) {
      console.log("zip: " + name + ": " + (e && e.message ? e.message : String(e)));
      hadError = true;
    }
  }
  console.log("zip: extracted " + count + " entr" + (count === 1 ? "y" : "ies") + " from " + archive);
  return hadError ? 1 : 0;
}

async function readArchive(archive) {
  try {
    var blob = await fs.readBlob(typeof fs._resolve === "function" ? fs._resolve(archive) : archive);
    return new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    console.log("zip: " + archive + ": No such file or directory");
    return null;
  }
}

function findEocd(bytes) {
  var min = bytes.length >= 22 ? bytes.length - 22 : 0;
  for (var i = bytes.length - 22; i >= min; i--) {
    if (rdU32(bytes, i) === EOCD_SIG) return i;
  }
  return null;
}
