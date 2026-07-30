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

// ─── Mount Registry ─────────────────────────────────────────────

class VirtualFS {
  constructor() {
    this.mounts = [];
    this.cwd = "/home";

    // Register filesystem backends
    this.mount("ram", "/tmp", new RamFS());
    this.mount("ram", "/home", new RamFS());
    this.mount("ram", "/commands", new RamFS());

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
