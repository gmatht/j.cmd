// -------------------------------------------------------------------
// Virtual Filesystem Layer
// JavaScript is the "binary" — this is the runtime that shell scripts
// compile down to. Every path is a file. Every file has a backend.
//
// Mount table:
//   /tmp/         → RamFS       (ephemeral, in-memory)
//   /home/        → LocalStorage (persistent across reloads)
//   /pc/          → DownloadFS  (write = browser download, read = file picker)
//   /http/        → HttpFS      (fetch with caching)
//   /mount/github → GitHubFS    (GitHub API as a filesystem)
//   /dev/input    → InputFS     (keyboard state)
//   /dev/webgl    → WebglFS     (GPU as a filesystem)
// -------------------------------------------------------------------

import { RamFS } from "./ramfs.js";
import { HttpFS } from "./httpfs.js";
import { GitHubFS } from "./githubfs.js";

// ─── RootFS: A virtual directory that shows mount points ───────
// When listing the root or any prefix that contains mount boundaries,
// this backend merges the underlying RamFS entries with synthetic
// directory entries for each registered mount point.

class RootFS {
  constructor(vfs) {
    this.vfs = vfs;
    this.files = new Map();
    this.dirs = new Set(["/"]);
  }

  _parent(path) {
    const p = path.replace(/\/+$/, "");
    const i = p.lastIndexOf("/");
    return i === 0 ? "/" : p.slice(0, i);
  }

  _ensureParent(path) {
    const parent = this._parent(path);
    if (!this.dirs.has(parent)) {
      this._ensureParent(parent);
      this.dirs.add(parent);
    }
  }

  async read(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) throw new Error("EISDIR: Is a directory");
    const data = this.files.get(norm);
    if (data === undefined) throw new Error("ENOENT");
    return new TextDecoder().decode(data);
  }

  async write(path, content) {
    const norm = path.replace(/\/$/, "") || "/";
    this._ensureParent(norm);
    this.files.set(norm, new TextEncoder().encode(content));
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";

    // Collect entries from our own files
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

    // Also inject mount point directories: any mount whose prefix is
    // a direct child of the listed path gets a synthetic directory entry.
    for (const m of this.vfs.mounts) {
      if (m.prefix.startsWith(prefix) && m.prefix !== norm) {
        const rest = m.prefix.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name + "/");
      }
    }

    return [...entries].sort();
  }

  async remove(path) {
    const norm = path.replace(/\/$/, "") || "/";
    this.files.delete(norm);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(norm + "/")) this.files.delete(key);
    }
    this.dirs.delete(norm);
  }
}

// ─── Mount Registry ─────────────────────────────────────────────

class VirtualFS {
  constructor() {
    this.mounts = [];
    this.cwd = "/home";

    // Root filesystem — shows mount points as directories
    const root = new RootFS(this);
    this.mount("root", "/", root);

    // Register filesystem backends
    this.mount("ram", "/tmp", new RamFS());
    this.mount("ram", "/home", new RamFS());
    this.mount("ram", "/commands", new RamFS());
    this.mount("http", "/http", new HttpFS());
    this.mount("github", "/mount/github", new GitHubFS());

    // Default files
    this.write("/home/hello.txt", "Hello from the virtual filesystem!\n");
    this.write("/tmp/README", "This is ramfs. Contents lost on reload.\n");

    // Pre-populate /commands/ with example "binaries"
    this.write("/commands/sayhello.js", `
const name = args[0] || "world";
console.log("Hello, " + name + "!");
`.trim());
    this.write("/commands/counter.js", `
const counterPath = "/tmp/counter.txt";
let count;
try {
  const raw = await fs.read(counterPath);
  count = parseInt(raw.trim(), 10) || 0;
} catch { count = 0; }
count++;
await fs.write(counterPath, String(count));
console.log("Invocation #" + count);
`.trim());
  }

  mount(name, prefix, backend) {
    this.mounts.push({ name, prefix, backend });
    // Sort longest prefix first so /mount/github matches before /mount
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  _resolve(path) {
    // Resolve relative paths against cwd
    let resolved = path;
    if (!path.startsWith("/")) {
      resolved = (this.cwd === "/" ? "/" : this.cwd + "/") + path;
    }
    // Normalize: remove .. and .
    const parts = resolved.split("/").filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (p === "..") out.pop();
      else if (p !== ".") out.push(p);
    }
    return "/" + out.join("/");
  }

  _findBackend(resolvedPath) {
    for (const m of this.mounts) {
      if (resolvedPath.startsWith(m.prefix)) {
        const relative = resolvedPath.slice(m.prefix.length) || "/";
        return { backend: m.backend, relative };
      }
    }
    return null;
  }

  async read(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    return m.backend.read(m.relative);
  }

  async write(path, content) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    return m.backend.write(m.relative, content);
  }

  async list(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    return m.backend.list(m.relative);
  }

  async remove(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    return m.backend.remove(m.relative);
  }

  async exists(path) {
    try {
      await this.read(path);
      return true;
    } catch {
      return false;
    }
  }

  // Print a directory listing in 'ls' format
  async formatList(path) {
    const entries = await this.list(path);
    if (entries.length === 0) return "";
    // Simple column layout
    const cols = 4;
    const widths = entries.map(e => e.length);
    const colW = Math.max(...widths) + 2;
    const rows = [];
    for (let i = 0; i < entries.length; i += cols) {
      rows.push(
        entries.slice(i, i + cols)
          .map((e, j) => j === cols - 1 ? e : e.padEnd(colW))
          .join("")
      );
    }
    return rows.join("\n") + "\n";
  }
}

// Singleton
export const fs = new VirtualFS();
