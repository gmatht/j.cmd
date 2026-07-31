// ─── LocalStorageFS: Persistent filesystem backed by localStorage ─
//
// Survives page reloads. Data lives in the browser's localStorage.
// Size limit: ~5-10MB (per origin). Great for /home/, config files.
//
// localStorage keys are prefixed with "fs:" to avoid collisions with
// other data the application might store.
// -----------------------------------------------------------------

const KEY_PREFIX = "fs:";

export class LocalStorageFS {
  constructor() {
    // We maintain a directory index in localStorage for fast listing.
    // The index is a JSON array of directory paths.
    this._initIndex();
  }

  _initIndex() {
    if (localStorage.getItem(KEY_PREFIX + ".dirs") === null) {
      localStorage.setItem(KEY_PREFIX + ".dirs", JSON.stringify(["/"]));
    }
  }

  _dirs() {
    return JSON.parse(localStorage.getItem(KEY_PREFIX + ".dirs") || "[]");
  }

  _saveDirs(dirs) {
    localStorage.setItem(KEY_PREFIX + ".dirs", JSON.stringify([...new Set(dirs)].sort()));
  }

  _addDir(dir) {
    const dirs = this._dirs();
    if (!dirs.includes(dir)) {
      dirs.push(dir);
      this._saveDirs(dirs);
    }
  }

  _parent(path) {
    const p = path.replace(/\/+$/, "");
    // Root or empty → root
    if (p === "" || p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i === 0 ? "/" : p.slice(0, i);
  }

  _ensureParent(path) {
    const parent = this._parent(path);
    // Stop at root — it's always in the dirs index
    if (parent === "/") return;
    const dirs = this._dirs();
    if (!dirs.includes(parent)) {
      this._ensureParent(parent);
      dirs.push(parent);
      this._saveDirs(dirs);
    }
  }

  async read(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();
    if (dirs.includes(norm)) throw new Error("EISDIR: Is a directory");

    const key = KEY_PREFIX + "file:" + norm;
    const data = localStorage.getItem(key);
    if (data === null) throw new Error("ENOENT");
    return data;
  }

  async write(path, content) {
    const norm = path.replace(/\/$/, "") || "/";
    this._ensureParent(norm);
    localStorage.setItem(KEY_PREFIX + "file:" + norm, content);
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();
    if (!dirs.includes(norm)) throw new Error("ENOTDIR");

    const prefix = norm === "/" ? "/" : norm + "/";
    const entries = new Set();

    // List files in localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX + "file:")) {
        const filePath = key.slice((KEY_PREFIX + "file:").length);
        if (filePath.startsWith(prefix) && filePath !== prefix) {
          const rest = filePath.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) entries.add(name);
        }
      }
    }

    // List subdirectories
    for (const dir of dirs) {
      if (dir.startsWith(prefix) && dir !== norm) {
        const rest = dir.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name + "/");
      }
    }

    return [...entries].sort();
  }

  async remove(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();

    if (dirs.includes(norm)) {
      // Remove all children
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(KEY_PREFIX + "file:" + norm + "/")) {
          localStorage.removeItem(key);
        }
      }
      // Remove subdirectory entries
      this._saveDirs(dirs.filter(d => !d.startsWith(norm + "/") && d !== norm));
    } else {
      localStorage.removeItem(KEY_PREFIX + "file:" + norm);
    }
  }
}
