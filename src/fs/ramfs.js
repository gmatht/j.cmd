// ─── RamFS: In-memory filesystem ────────────────────────────────
// Data survives only until the page/tab closes.

export class RamFS {
  constructor() {
    this.files = new Map();      // path → Uint8Array
    this.dirs = new Set(["/"]);  // path strings that are directories
    this.mtimes = new Map();     // path → epoch ms of last write
  }

  _parent(path) {
    const p = path.replace(/\/+$/, "");
    if (p === "" || p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i === 0 ? "/" : p.slice(0, i);
  }

  _ensureParent(path) {
    const parent = this._parent(path);
    if (parent === "/") return;  // root always exists
    if (!this.dirs.has(parent)) {
      this._ensureParent(parent);
      this.dirs.add(parent);
      this.mtimes.set(parent, Date.now());
    }
  }

  async read(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) throw new Error("EISDIR");
    const data = this.files.get(norm);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(data);
  }

  async readBlob(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) throw new Error("EISDIR");
    const data = this.files.get(norm);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return new Blob([data]);
  }

  async write(path, content) {
    const norm = path.replace(/\/$/, "") || "/";
    this._ensureParent(norm);
    const encoded = typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
    this.files.set(norm, encoded);
    this.mtimes.set(norm, Date.now());
  }

  async writeBlob(path, blob) {
    const norm = path.replace(/\/$/, "") || "/";
    this._ensureParent(norm);
    const buffer = await blob.arrayBuffer();
    this.files.set(norm, new Uint8Array(buffer));
    this.mtimes.set(norm, Date.now());
  }

  async stat(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) {
      return { type: "dir", size: 0, mtime: this.mtimes.get(norm) };
    }
    const data = this.files.get(norm);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return { type: "file", size: data.length, mtime: this.mtimes.get(norm) };
  }

  // Synchronous stat — used by sh2.test file tests (local mounts only).
  statSync(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) return { type: "dir", size: 0, mtime: this.mtimes.get(norm) };
    const data = this.files.get(norm);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return { type: "file", size: data.length, mtime: this.mtimes.get(norm) };
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (!this.dirs.has(norm)) throw new Error(`ENOTDIR: ${path}`);
    const entries = new Set();
    const prefix = norm === "/" ? "/" : norm + "/";
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix) && key !== prefix) {
        const rest = key.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name);
      }
    }
    for (const key of this.dirs) {
      if (key.startsWith(prefix) && key !== norm) {
        const rest = key.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name + "/");
      }
    }
    return [...entries].sort().filter((e, i, arr) => !(e + "/" === arr[i + 1]));
  }

  async remove(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) {
      // Remove all children
      for (const key of [...this.files.keys()]) {
        if (key.startsWith(norm + "/")) this.files.delete(key);
      }
      for (const key of [...this.dirs.keys()]) {
        if (key.startsWith(norm + "/") && key !== norm) this.dirs.delete(key);
      }
      this.dirs.delete(norm);
    } else {
      this.files.delete(norm);
    }
    for (const key of [...this.mtimes.keys()]) {
      if (key === norm || key.startsWith(norm + "/")) this.mtimes.delete(key);
    }
  }
}
