// -------------------------------------------------------------------
// Virtual Filesystem Layer
// JavaScript is the "binary" — this is the runtime that shell scripts
// compile down to. Every path is a file. Every file has a backend.
//
// Mount table:
//   /             → RootFS        (aggregates mount points)
//   /tmp/         → RamFS         (ephemeral, in-memory)
//   /home/        → LocalStorageFS(persistent across reloads)
//   /commands/    → LocalStorageFS(persistent user commands)
//   /http/        → HttpFS        (CORS fetch access)
//   /mount/github → GitHubFS      (GitHub API as a filesystem)
// -------------------------------------------------------------------

import { RamFS } from "./ramfs.js";
import { LocalStorageFS } from "./localstoragefs.js";
import { HttpFS } from "./httpfs.js";
import { GitHubFS } from "./githubfs.js";
import { GitLabFS } from "./gitlabfs.js";
import { DevFS } from "./devfs.js";
import { DownloadFS } from "./downloadfs.js";

// ─── RootFS: A virtual directory that shows mount points ───────

class RootFS {
  constructor(vfs) {
    this.vfs = vfs;
    this.files = new Map();
    this.dirs = new Set(["/"]);
    this.mtimes = new Map();  // path → epoch ms of last write
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
      this.mtimes.set(parent, Date.now());
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
    this.mtimes.set(norm, Date.now());
  }

  async stat(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (this.dirs.has(norm)) {
      return { type: "dir", size: 0, mtime: this.mtimes.get(norm) };
    }
    const data = this.files.get(norm);
    if (data === undefined) throw new Error("ENOENT");
    return { type: "file", size: data.length, mtime: this.mtimes.get(norm) };
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";
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
    // Inject mount point directories
    for (const m of this.vfs.mounts) {
      if (m.prefix.startsWith(prefix) && m.prefix !== norm) {
        const rest = m.prefix.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name + "/");
      }
    }
    return [...entries].sort().filter((e, i, arr) => !(e + "/" === arr[i + 1]));
  }

  async remove(path) {
    const norm = path.replace(/\/$/, "") || "/";
    this.files.delete(norm);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(norm + "/")) this.files.delete(key);
    }
    this.dirs.delete(norm);
    for (const key of [...this.mtimes.keys()]) {
      if (key === norm || key.startsWith(norm + "/")) this.mtimes.delete(key);
    }
  }
}

// ─── Synchronous wrapper for LocalStorageFS writes during init ──

function syncWrite(backend, path, content) {
  // LocalStorageFS is synchronous under the hood despite the async API
  backend.write(path, content);
}

// ─── VirtualFS ─────────────────────────────────────────────────

class VirtualFS {
  constructor() {
    this.mounts = [];
    this.cwd = "/home";

    // Root filesystem — shows mount points as directories
    const root = new RootFS(this);
    this.mount("root", "/", root);

    // Detect whether localStorage is available (browser vs Node.js)
    const hasLocalStorage = typeof localStorage !== "undefined";

    // Register filesystem backends
    this.mount("ram", "/tmp", new RamFS());
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/home",
      hasLocalStorage ? new LocalStorageFS() : new RamFS());
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/commands",
      hasLocalStorage ? new LocalStorageFS() : new RamFS());
    this.mount("http", "/http", new HttpFS());
    const github = new GitHubFS();
    this.mount("github", "/mount/github", github);
    this.mount("github", "/github", github);
    const gitlab = new GitLabFS();
    this.mount("gitlab", "/mount/gitlab", gitlab);
    this.mount("gitlab", "/gitlab", gitlab);  // convenience alias
    this.mount("dev", "/dev", new DevFS());
    this.mount("download", "/pc", new DownloadFS());
    this.mount("ram", "/bin", new RamFS());

    // Initialize default files
    if (hasLocalStorage && !localStorage.getItem("fs:initialized")) {
      localStorage.setItem("fs:initialized", "1");
      syncWrite(this._getBackend("/home/hello.txt"), "/hello.txt",
        "Hello from localStorage! This survives reload.\n");
      syncWrite(this._getBackend("/home/.welcome"), "/.welcome",
        "Files in /home/ persist across page reloads.\n");
    } else if (!hasLocalStorage) {
      // No localStorage (Node.js), write init files to RamFS
      syncWrite(this._getBackend("/home/hello.txt"), "/hello.txt",
        "Hello from RamFS! Contents lost on restart.\n");
    }
    syncWrite(this._getBackend("/tmp/README"), "/README",
      "This is ramfs. Contents lost on reload.\n");

    // Pre-populate commands
    const helloContent = `const name = args[0] || "world";\nconsole.log("Hello, " + name + "!");\n`;
    const counterContent = `const counterPath = "/tmp/counter.txt";\nlet count;\ntry {\n  const raw = await fs.read(counterPath);\n  count = parseInt(raw.trim(), 10) || 0;\n} catch { count = 0; }\ncount++;\nawait fs.write(counterPath, String(count));\nconsole.log("Invocation #" + count);\n`;
    syncWrite(this._getBackend("/commands/sayhello.js"), "/sayhello.js", helloContent);
    syncWrite(this._getBackend("/commands/counter.js"), "/counter.js", counterContent);

    // Sample content for new users
    syncWrite(this._getBackend("/home/examples/README.txt"), "/examples/README.txt",
      `Welcome to tinysh!\n\n` +
      `Try these commands:\n` +
      `  ls /mount/github/gmatht/sh2perl  -- browse a GitHub repo\n` +
      `  cat /mount/github/gmatht/sh2perl/README.md  -- read a file\n` +
      `  cat /home/examples/hello.sh      -- a sample script\n` +
      `  edit /home/examples/note.txt     -- edit a file\n` +
      `  ls /dev/                         -- browser devices\n` +
      `  cat /dev/info                    -- system info\n`);
    syncWrite(this._getBackend("/home/examples/hello.sh"), "/examples/hello.sh",
      `echo "Hello from the browser shell!"\n` +
      `name="world"\n` +
      `echo "Hello, \$name!"\n` +
      `for i in 1 2 3; do\n` +
      `  echo "Counting: \$i"\n` +
      `done\n`);
    syncWrite(this._getBackend("/home/examples/note.txt"), "/examples/note.txt",
      `Notes\n=====\n\nEdit this file with:  edit /home/examples/note.txt\n` +
      `Ctrl+S to save, Esc to cancel.\n`);
  }

  _getBackend(resolvedPath) {
    for (const m of this.mounts) {
      if (resolvedPath.startsWith(m.prefix)) {
        return m.backend;
      }
    }
    return null;
  }

  mount(name, prefix, backend) {
    this.mounts.push({ name, prefix, backend });
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  _resolve(path) {
    let resolved = path;
    if (!path.startsWith("/")) {
      resolved = (this.cwd === "/" ? "/" : this.cwd + "/") + path;
    }
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
        let relative = resolvedPath.slice(m.prefix.length) || "/";
        // Ensure relative path always starts with "/" — when the matching
        // prefix is "/" (root), the slice strips it and we lose the leading
        // slash unless we re-add it.
        if (!relative.startsWith("/")) relative = "/" + relative;
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

  async readBlob(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    if (m.backend.readBlob) {
      return m.backend.readBlob(m.relative);
    }
    const text = await m.backend.read(m.relative);
    return new Blob([text], { type: "text/plain" });
  }

  async writeBlob(path, blob) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    if (m.backend.writeBlob) {
      return m.backend.writeBlob(m.relative, blob);
    }
    // Fallback: read blob as text and write
    const text = await blob.text();
    return m.backend.write(m.relative, text);
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

  // ─── stat: metadata for a single path ───────────────────────
  // Returns { type: "file"|"dir", size: number, mtime: ms|undefined }.
  // Backends may implement their own stat(); otherwise we fall back
  // to reading the file (dirs throw EISDIR/ENOTDIR).

  async stat(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    if (m.backend.stat) {
      return m.backend.stat(m.relative);
    }
    try {
      const content = await m.backend.read(m.relative);
      return { type: "file", size: content.length, mtime: undefined };
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("EISDIR") || msg.includes("ENOTDIR")) {
        return { type: "dir", size: 0, mtime: undefined };
      }
      throw e;
    }
  }

  // ─── formatList: human-readable directory listing ───────────

  async formatList(path, opts = {}) {
    const entries = await this.list(path);
    if (entries.length === 0) return "";
    if (opts.long) return await this.formatLongList(path, entries);

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

  // Long format: permissions, nlink, owner, group, size, date, name
  async formatLongList(path, entries) {
    const rows = [];
    for (const entry of entries) {
      const isDir = entry.endsWith("/");
      const name = isDir ? entry.slice(0, -1) : entry;
      let st = null;
      try {
        st = await this.stat(path + "/" + entry);
      } catch {
        st = null;  // remote/virtual backends without metadata
      }
      const type = isDir ? "dir" : (st && st.type) || "file";
      const size = st && st.size !== undefined ? st.size : (isDir ? 0 : "-");
      const mtime = st && st.mtime;
      rows.push({
        mode: type === "dir" ? "drwxr-xr-x" : "-rw-r--r--",
        size,
        date: formatMtime(mtime),
        name,
      });
    }
    const sizeW = Math.max(...rows.map(r => String(r.size).length));
    const dateW = Math.max(...rows.map(r => r.date.length));
    return rows.map(r =>
      `${r.mode} 1 tinysh tinysh ${String(r.size).padStart(sizeW)} ${r.date.padEnd(dateW)} ${r.name}`
    ).join("\n") + "\n";
  }
}

// Unix-style date column: "Mon DD HH:MM" for this year, else "Mon DD  YYYY"
function formatMtime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const months = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2);
  if (d.getFullYear() === new Date().getFullYear()) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${mon} ${day} ${hh}:${mm}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}

// Singleton
export const fs = new VirtualFS();
