// ─── IndexedDBFS: Persistent filesystem backed by IndexedDB ─────
//
// Browser-native storage with no practical size limit — unlike the
// ~5MB per-origin quota of localStorage, IndexedDB can hold much
// larger files (hundreds of MB). That makes it the right home for
// files that outgrow /home/ (LocalStorageFS).
//
// File contents are stored as Blobs in an object store, so binary
// data and multi-megabyte files survive reloads byte-for-byte.
//
// IndexedDB is asynchronous, so every method lazily opens the
// database on first use; the constructor stays synchronous to fit
// the VirtualFS mount table.
//
// Database layout (sh2runtime-fs, version 1):
//   files → { path, blob }                    — file contents
//   meta  → { path: "meta", dirs, mtimes }    — directory index + mtimes
//
// Metadata read-modify-write cycles are serialized through a promise
// chain because, unlike the synchronous localStorage API, IndexedDB
// transactions are async and could otherwise interleave.
// -----------------------------------------------------------------

const DB_NAME = "sh2runtime-fs";
const DB_VERSION = 1;
const FILES_STORE = "files";
const META_STORE = "meta";

// Simple async mutex: serializes metadata mutations so concurrent
// commands can't lose directory-index updates.
let _lock = Promise.resolve();
function _withLock(fn) {
  const run = _lock.then(fn, fn);
  _lock = run.then(() => {}, () => {});
  return run;
}

function normalize(path) {
  return path.replace(/\/+$/, "") || "/";
}

export class IndexedDBFS {
  constructor() {
    this._dbPromise = null;
  }

  // ─── Low-level IndexedDB helpers ────────────────────────────

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: "path" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "path" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
    return this._dbPromise;
  }

  _tx(store, mode, run) {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      try {
        run(tx.objectStore(store));
      } catch (e) {
        tx.abort();
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  _get(store, key) {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  // ─── Metadata (dirs index + mtimes), serialized ─────────────

  async _getMeta() {
    const rec = await this._get(META_STORE, "meta");
    return rec || { path: "meta", dirs: ["/"], mtimes: {} };
  }

  _saveMeta(meta) {
    return this._tx(META_STORE, "readwrite", (os) => os.put(meta));
  }

  _mutateMeta(fn) {
    return _withLock(async () => {
      const meta = await this._getMeta();
      if (fn(meta)) await this._saveMeta(meta);
    });
  }

  _parent(path) {
    const p = path.replace(/\/+$/, "");
    if (p === "" || p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i === 0 ? "/" : p.slice(0, i);
  }

  async _ensureParent(path) {
    const parent = this._parent(path);
    if (parent === "/") return;  // root always exists
    await this._mutateMeta((meta) => {
      if (meta.dirs.includes(parent)) return false;
      // Recursively create ancestors
      let p = parent;
      const missing = [];
      while (p !== "/" && !meta.dirs.includes(p)) {
        missing.push(p);
        p = this._parent(p);
      }
      for (const d of missing.reverse()) {
        meta.dirs.push(d);
        if (!(d in meta.mtimes)) meta.mtimes[d] = Date.now();
      }
      return true;
    });
  }

  _touch(path, mtime = Date.now()) {
    return this._mutateMeta((meta) => {
      if (meta.mtimes[path] === mtime) return false;
      meta.mtimes[path] = mtime;
      return true;
    });
  }

  _dropMeta(path) {
    return this._mutateMeta((meta) => {
      let changed = false;
      for (const key of Object.keys(meta.mtimes)) {
        if (key === path || key.startsWith(path + "/")) {
          delete meta.mtimes[key];
          changed = true;
        }
      }
      if (path === "/" || path === "") {
        if (meta.dirs.length !== 1 || meta.dirs[0] !== "/") {
          meta.dirs = ["/"];
          changed = true;
        }
      }
      return changed;
    });
  }

  // ─── Files ──────────────────────────────────────────────────

  async read(path) {
    const norm = normalize(path);
    const meta = await this._getMeta();
    if (meta.dirs.includes(norm)) throw new Error("EISDIR: Is a directory");
    const rec = await this._get(FILES_STORE, norm);
    if (!rec) throw new Error(`ENOENT: ${path}`);
    return await rec.blob.text();
  }

  async readBlob(path) {
    const norm = normalize(path);
    const meta = await this._getMeta();
    if (meta.dirs.includes(norm)) throw new Error("EISDIR: Is a directory");
    const rec = await this._get(FILES_STORE, norm);
    if (!rec) throw new Error(`ENOENT: ${path}`);
    return rec.blob;
  }

  async write(path, content) {
    const norm = normalize(path);
    await this._ensureParent(norm);
    const blob = typeof content === "string"
      ? new Blob([content], { type: "text/plain" })
      : (content instanceof Blob ? content : new Blob([content]));
    await this._tx(FILES_STORE, "readwrite", (os) => os.put({ path: norm, blob }));
    await this._touch(norm);
  }

  async writeBlob(path, blob) {
    const norm = normalize(path);
    await this._ensureParent(norm);
    await this._tx(FILES_STORE, "readwrite", (os) => os.put({ path: norm, blob }));
    await this._touch(norm);
  }

  async stat(path) {
    const norm = normalize(path);
    const meta = await this._getMeta();
    if (meta.dirs.includes(norm)) {
      return { type: "dir", size: 0, mtime: meta.mtimes[norm] };
    }
    const rec = await this._get(FILES_STORE, norm);
    if (!rec) throw new Error(`ENOENT: ${path}`);
    return { type: "file", size: rec.blob.size, mtime: meta.mtimes[norm] };
  }

  async list(path) {
    const norm = normalize(path);
    const meta = await this._getMeta();
    if (!meta.dirs.includes(norm)) throw new Error(`ENOTDIR: ${path}`);

    const prefix = norm === "/" ? "/" : norm + "/";
    const entries = new Set();

    // Files in the store under this prefix (key range scan)
    const recs = await this._scanKeys(FILES_STORE, prefix);
    for (const filePath of recs) {
      if (filePath === prefix) continue;
      const rest = filePath.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) entries.add(name);
    }

    // Subdirectories from the index
    for (const dir of meta.dirs) {
      if (dir.startsWith(prefix) && dir !== norm) {
        const rest = dir.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name + "/");
      }
    }

    return [...entries].sort().filter((e, i, arr) => !(e + "/" === arr[i + 1]));
  }

  // Collect all keys in a store starting with `prefix` (lexicographic).
  _scanKeys(store, prefix) {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const os = tx.objectStore(store);
      const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
      const req = os.openKeyCursor(range);
      const keys = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { keys.push(cursor.key); cursor.continue(); }
        else resolve(keys);
      };
      req.onerror = () => reject(req.error);
    }));
  }

  async remove(path) {
    const norm = normalize(path);
    const meta = await this._getMeta();

    if (meta.dirs.includes(norm)) {
      // Remove all file records under this directory (range delete)
      const prefix = norm === "/" ? "/" : norm + "/";
      await this._tx(FILES_STORE, "readwrite", (os) => {
        os.delete(IDBKeyRange.bound(prefix, prefix + "\uffff"));
      });
      // Drop subdirectory entries + mtimes
      await this._mutateMeta((m) => {
        m.dirs = m.dirs.filter((d) => d !== norm && !d.startsWith(norm + "/"));
        if (!m.dirs.includes("/")) m.dirs.unshift("/");  // root always exists
        for (const key of Object.keys(m.mtimes)) {
          if (key === norm || key.startsWith(norm + "/")) delete m.mtimes[key];
        }
        return true;
      });
    } else {
      await this._tx(FILES_STORE, "readwrite", (os) => os.delete(norm));
      await this._dropMeta(norm);
    }
  }
}
