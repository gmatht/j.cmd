// ─── zipfs.js — read-only VFS backend over a ZIP archive ───────
//
// Lets users cd into .zip files: the VirtualFS lazily mounts any .zip
// file at its own path, wrapped in an OverlayFS (writes inside the
// mounted dir land in the overlay, never in the archive). This backend
// serves list/stat/read/readBlob from the archive's central directory;
// entry data is inflated with pako (browser) or node:zlib (CLI) — the
// same wire format /bin/zip.js produces.
//
//   cd /home/backup.zip        → browse the archive like a directory
//   ls /home/backup.zip/docs/
//   cat /home/backup.zip/readme.txt
//   cp /home/backup.zip/notes.txt /home/   (extract one file)
//   cp /home/backup.zip /pc/               (the raw archive still copies)
// -----------------------------------------------------------------
import { ensurePako } from "../pako.js";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function rdU32(u8, off) { return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0; }
function rdU16(u8, off) { return (u8[off] | (u8[off + 1] << 8)) & 0xffff; }

function findEocd(bytes) {
  const min = bytes.length >= 22 ? bytes.length - 22 : 0;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (rdU32(bytes, i) === EOCD_SIG) return i;
  }
  return null;
}

// DOS date/time → epoch ms (undefined when the zip has no timestamp).
function dosToMs(dt, dd) {
  if (dd === 0) return undefined;
  return new Date(
    1980 + ((dd >> 9) & 0x7f), ((dd >> 5) & 0x0f) - 1, dd & 0x1f,
    (dt >> 11) & 0x1f, (dt >> 5) & 0x3f, (dt & 0x1f) * 2
  ).getTime();
}

export class ZipFS {
  constructor(bytes) {
    this.bytes = bytes;
    this._parsed = false;
    this._dirs = new Set([""]);     // normalized dir paths ("" = root)
    this._files = new Map();        // normalized file path → entry
    this._children = new Map();     // dir path → sorted [names…] ("dir/" suffixed)
    this._inflate = null;
  }

  // Parse the central directory (throws "not a zip archive" on junk).
  _parse() {
    if (this._parsed) return;
    const bytes = this.bytes;
    const eocd = findEocd(bytes);
    if (eocd === null) throw new Error("not a zip archive");
    const count = rdU16(bytes, eocd + 10);
    const cdOff = rdU32(bytes, eocd + 16);
    const dec = new TextDecoder();
    const files = new Map();
    const dirs = new Set([""]);
    let pos = cdOff;
    for (let i = 0; i < count; i++) {
      if (rdU32(bytes, pos) !== CENTRAL_SIG) break;
      const method = rdU16(bytes, pos + 10);
      const compSize = rdU32(bytes, pos + 20);
      const uncompSize = rdU32(bytes, pos + 24);
      const nameLen = rdU16(bytes, pos + 28);
      const localOff = rdU32(bytes, pos + 42);
      const dt = rdU16(bytes, pos + 12);
      const dd = rdU16(bytes, pos + 14);
      const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
        .replace(/\\/g, "/");      // Windows zips use backslash separators
      pos += 46 + nameLen + rdU16(bytes, pos + 30) + rdU16(bytes, pos + 32);
      // Normalize: drop "." components and empty parts (zips made with
      // `zip x .` carry "./"-prefixed names) while keeping the dir marker.
      const norm = name.split("/").filter((c) => c && c !== ".").join("/");
      if (name.endsWith("/")) {
        dirs.add(norm || "");
      } else {
        files.set(norm, { method, compSize, uncompSize, localOff, mtime: dosToMs(dt, dd) });
      }
    }
    // Implicit parent directories (a zip may list "a/b/c.txt" with no
    // "a/" or "a/b/" entries).
    for (const p of files.keys()) {
      let d = p;
      while (d.includes("/")) {
        d = d.slice(0, d.lastIndexOf("/"));
        dirs.add(d);
      }
    }
    // Direct children of each directory.
    const children = new Map();
    const addChild = (dir, name) => {
      let arr = children.get(dir);
      if (!arr) { arr = []; children.set(dir, arr); }
      if (!arr.includes(name)) arr.push(name);
    };
    for (const f of files.keys()) {
      const i = f.lastIndexOf("/");
      addChild(i === -1 ? "" : f.slice(0, i), f.slice(i + 1));
    }
    for (const d of dirs) {
      if (d === "") continue;
      const i = d.lastIndexOf("/");
      addChild(i === -1 ? "" : d.slice(0, i), d.slice(i + 1) + "/");
    }
    for (const arr of children.values()) arr.sort();
    this._files = files;
    this._dirs = dirs;
    this._children = children;
    this._parsed = true;
  }

  _norm(path) {
    const p = String(path == null ? "" : path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return p;   // "" is the archive root
  }

  async list(path) {
    this._parse();
    const norm = this._norm(path);
    if (this._files.has(norm)) throw new Error("ENOTDIR: Not a directory");
    return (this._children.get(norm) || []).slice();
  }

  async stat(path) {
    this._parse();
    const norm = this._norm(path);
    if (this._dirs.has(norm)) return { type: "dir", size: 0, mtime: undefined };
    const f = this._files.get(norm);
    if (!f) throw new Error("ENOENT");
    return { type: "file", size: f.uncompSize, mtime: f.mtime };
  }

  statSync(path) {
    try { this._parse(); } catch { return null; }
    const norm = this._norm(path);
    if (this._dirs.has(norm)) return { type: "dir", size: 0, mtime: undefined };
    const f = this._files.get(norm);
    if (!f) return null;
    return { type: "file", size: f.uncompSize, mtime: f.mtime };
  }

  async read(path) {
    const data = await this._readEntry(path);
    return new TextDecoder().decode(data);
  }

  async readBlob(path) {
    const data = await this._readEntry(path);
    return new Blob([data]);
  }

  async _readEntry(path) {
    this._parse();
    const norm = this._norm(path);
    if (this._dirs.has(norm)) throw new Error("EISDIR: Is a directory");
    const f = this._files.get(norm);
    if (!f) throw new Error("ENOENT");
    const bytes = this.bytes;
    const dataOff = f.localOff + 30 + rdU16(bytes, f.localOff + 26) + rdU16(bytes, f.localOff + 28);
    const comp = bytes.subarray(dataOff, dataOff + f.compSize);
    if (f.method === 0) return comp;                       // stored
    if (f.method === 8) return (await this._inflater())(comp);  // deflate
    throw new Error(`zip: unsupported compression method ${f.method}`);
  }

  // pako in the browser, node:zlib in the CLI (same engine /bin/zip.js uses).
  async _inflater() {
    if (this._inflate) return this._inflate;
    if (typeof window !== "undefined") {
      await ensurePako();  // lazy-load vendor/pako.min.js on first zip browse
      if (window.pako && window.pako.inflateRaw) {
        this._inflate = (u8) => new Uint8Array(window.pako.inflateRaw(u8));
        return this._inflate;
      }
    }
    const nz = await import("node:zlib");
    this._inflate = (u8) => new Uint8Array(nz.inflateRawSync(u8));
    return this._inflate;
  }

  async write() { throw new Error("EROFS: zip archives are read-only (cp files out to extract)"); }
  async writeBlob() { throw new Error("EROFS: zip archives are read-only (cp files out to extract)"); }
  async remove() { throw new Error("EROFS: zip archives are read-only"); }
}
