// -------------------------------------------------------------------
// Virtual Filesystem Layer
// JavaScript is the "binary" — this is the runtime that shell scripts
// compile down to. Every path is a file. Every file has a backend.
//
// Mount table:
//   /             → RootFS        (aggregates mount points)
//   /tmp/         → RamFS         (ephemeral, in-memory)
//   /home/        → LocalStorageFS(persistent across reloads, ~5MB limit)
//   /big/         → IndexedDBFS   (persistent, no practical size limit)
//   /commands/    → LocalStorageFS(persistent user commands)
//   /http/        → HttpFS        (CORS fetch access)
//   /proc/        → ProcFS        (process info + browser stats)
//   /mount/github → GitHubFS      (GitHub API as a filesystem)
//   /mount/gitlab → GitLabFS      (GitLab API as a filesystem)
//   /mount/git    → GitFS         (real git wire protocol over HTTP)
// -------------------------------------------------------------------

import { RamFS } from "./ramfs.js";
import { LocalStorageFS } from "./localstoragefs.js";
import { IndexedDBFS } from "./indexeddbfs.js";
import { HttpFS } from "./httpfs.js";
import { GitHubFS, GitHubRepoFS } from "./githubfs.js";
import { GitLabFS } from "./gitlabfs.js";
import { GitFS } from "./gitfs.js";
import { DevFS } from "./devfs.js";
import { DownloadFS } from "./downloadfs.js";
import { procfs } from "./procfs.js";

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

// ─── OverlayFS: copy-on-write layer over a read-only backend ──
// Writes to read-only mounts (github/gitlab/http/git) don't fail with
// EROFS — they land in a local overlay (in-memory + localStorage) and
// shadow the remote on read. The shell surfaces a warning that the
// change can't be committed until fork/(re)login.
const WHITEOUT = "\u0000WHITEOUT";
const B64 = "\u0001b64:";

function strToB64(s) {
  let bin = "";
  for (let i = 0; i < s.length; i++) bin += String.fromCharCode(s.charCodeAt(i));
  return btoa(bin);
}
function b64ToStr(b) {
  const bin = atob(b);
  let s = "";
  for (let i = 0; i < bin.length; i++) s += String.fromCharCode(bin.charCodeAt(i));
  return s;
}

class OverlayFS {
  constructor(backend, name, storagePrefix) {
    this.backend = backend;
    this.name = name;
    this.prefix = storagePrefix;
    this.files = new Map();  // relative path → string (or base64 marker)
    this._load();
  }

  _load() {
    if (typeof localStorage === "undefined") return;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(this.prefix)) {
          this.files.set(key.slice(this.prefix.length), localStorage.getItem(key));
        }
      }
    } catch {}
  }

  _save(path, content) {
    if (typeof localStorage !== "undefined") {
      try { localStorage.setItem(this.prefix + path, content); } catch {}
    }
  }

  _drop(path) {
    this.files.delete(path);
    if (typeof localStorage !== "undefined") {
      try { localStorage.removeItem(this.prefix + path); } catch {}
    }
  }

  async read(path) {
    if (this.files.has(path)) {
      const c = this.files.get(path);
      if (c === WHITEOUT) throw new Error("ENOENT");
      return c.startsWith(B64) ? b64ToStr(c.slice(B64.length)) : c;
    }
    return this.backend.read(path);
  }

  async readBlob(path) {
    if (this.files.has(path)) {
      const c = this.files.get(path);
      if (c === WHITEOUT) throw new Error("ENOENT");
      if (c.startsWith(B64)) {
        const bin = atob(c.slice(B64.length));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes]);
      }
      return new Blob([c], { type: "text/plain" });
    }
    return this.backend.readBlob ? this.backend.readBlob(path) : this.backend.read(path);
  }

  async write(path, content) {
    this.files.set(path, content);
    this._save(path, content);
    return { overlay: true };
  }

  async writeBlob(path, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const encoded = B64 + btoa(bin);
    this.files.set(path, encoded);
    this._save(path, encoded);
    return { overlay: true };
  }

  async list(path) {
    const base = this.backend.list
      ? (await this.backend.list(path).catch(() => []))
      : [];
    const entries = new Set(base);
    const norm = path.replace(/\/+$/, "") || "/";
    const prefix = norm === "/" ? "/" : norm + "/";
    for (const key of this.files.keys()) {
      if (key === WHITEOUT) continue;
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name);
      }
    }
    // "..." marks a truncated listing (rate-limited API) — force it to
    // the end so it reads like "and so on" rather than leading the list.
    return [...entries].sort((a, b) => {
      const ea = a === "..." ? 1 : 0;
      const eb = b === "..." ? 1 : 0;
      return (ea - eb) || (a < b ? -1 : a > b ? 1 : 0);
    });
  }

  // Cache metadata for a listing, if the wrapped backend caches (used by
  // the shells to print "cached X ago" next to remote listings).
  cacheInfo(path) {
    return this.backend.cacheInfo ? this.backend.cacheInfo(path) : null;
  }

  // Rolling-hour API usage after a fresh listing (from the API's own
  // RateLimit headers), or null when served from cache.
  rateInfo() {
    return this.backend.rateInfo ? this.backend.rateInfo() : null;
  }

  async remove(path) {
    if (this.files.has(path)) {
      this._drop(path);
      return;
    }
    // Removing a remote file → whiteout it locally
    this.files.set(path, WHITEOUT);
    this._save(path, WHITEOUT);
    return { overlay: true };
  }

  async stat(path) {
    if (this.files.has(path)) {
      const c = this.files.get(path);
      if (c === WHITEOUT) throw new Error("ENOENT");
      const text = c.startsWith(B64) ? c.slice(B64.length) : c;
      return { type: "file", size: text.length, mtime: Date.now() };
    }
    return this.backend.stat ? this.backend.stat(path) : null;
  }
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
    // IndexedDB only exists in the browser; in Node the CLI falls back
    // to an in-memory RamFS so /big/ still works (ephemerally).
    const hasIndexedDB = typeof indexedDB !== "undefined";

    // Register filesystem backends
    this.mount("ram", "/tmp", new RamFS());
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/home",
      hasLocalStorage ? new LocalStorageFS() : new RamFS());
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/commands",
      hasLocalStorage ? new LocalStorageFS() : new RamFS());
    this.mount("http", "/http", new OverlayFS(new HttpFS(), "http", "fs:ovl:http:"));
    const github = new OverlayFS(new GitHubFS(), "github", "fs:ovl:github:");
    this.mount("github", "/mount/github", github);
    this.mount("github", "/github", github);
    const gitlab = new OverlayFS(new GitLabFS(), "gitlab", "fs:ovl:gitlab:");
    this.mount("gitlab", "/mount/gitlab", gitlab);
    this.mount("gitlab", "/gitlab", gitlab);  // convenience alias
    // GitFS — real git over HTTP (smart or dumb). Path format:
    //   /mount/git/{host}/{repo-path}/{file-path}
    // e.g. /mount/git/github.com/torvalds/linux/README
    const git = new OverlayFS(new GitFS(), "git", "fs:ovl:git:");
    this.mount("git", "/mount/git", git);
    this.mount("git", "/git", git);  // convenience alias
    this.mount("dev", "/dev", new DevFS());
    this.mount("download", "/pc", new DownloadFS());
    // /proc/ — process info + browser stats. ProcFS keeps a registry of
    // every command tinysh runs (procfs.start/finish) and generates the
    // rest of the files from browser APIs (hardwareConcurrency, device-
    // Memory, performance.memory, navigation timing, mount table, ...).
    this.mount("proc", "/proc", procfs);
    procfs.setVfs(this);
    // IndexedDB-backed persistent store for large files — unlike
    // localStorage's ~5MB per-origin quota, IndexedDB has no practical
    // size limit, so /big/ is where files that outgrow /home/ belong.
    this.mount(hasIndexedDB ? "indexedDB" : "ram", "/big",
      hasIndexedDB ? new IndexedDBFS() : new RamFS());
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
    // Sample startup config — read by the shell at startup (interactive
    // mode). All lines here are commented out so first-run behaviour is
    // unchanged; uncomment to try the feature.
    const sampleRc =
      "# ~/.tinyshrc — tinysh startup config (read at shell startup)\n" +
      "# Each line is run as a shell command; '#' starts a comment.\n" +
      "# Uncomment to try:\n" +
      "# export EDITOR=edit\n" +
      "# export PATH=/commands:/usr/bin:/bin\n" +
      "# echo \"Welcome back to tinysh!\"\n";
    syncWrite(this._getBackend("/home/.tinyshrc"), "/.tinyshrc", sampleRc);
    syncWrite(this._getBackend("/tmp/README"), "/README",
      "This is ramfs. Contents lost on reload.\n");

    // Big-file store README (IndexedDBFS is async; fire-and-forget)
    const bigBackend = this._getBackend("/big/README");
    if (bigBackend) {
      bigBackend.write("/README",
        "This is IndexedDB storage. No practical size limit —" +
        " use it for files too big for /home/ (localStorage ~5MB).\n" +
        "Files here survive reloads. Binary-safe (writeBlob).\n")
        .catch(() => {});
    }

    // Pre-populate commands
    const helloContent = `const name = args[0] || "world";\nconsole.log("Hello, " + name + "!");\n`;
    const counterContent = `const counterPath = "/tmp/counter.txt";\nlet count;\ntry {\n  const raw = await fs.read(counterPath);\n  count = parseInt(raw.trim(), 10) || 0;\n} catch { count = 0; }\ncount++;\nawait fs.write(counterPath, String(count));\nconsole.log("Invocation #" + count);\n`;
    syncWrite(this._getBackend("/commands/sayhello.js"), "/sayhello.js", helloContent);
    syncWrite(this._getBackend("/commands/counter.js"), "/counter.js", counterContent);

    // WebGL device demo — draws a bouncing colored triangle via /dev/webgl.
    // Browser only: needs a WebGL context (run `webgldemo` in the shell).
    const webglDemoContent = `// webgldemo — bouncing colored triangle via /dev/webgl (browser only)
const vertex = \`attribute vec2 aPosition;
uniform vec2 uOffset;
uniform vec2 uScale;
void main() {
  vec2 pos = aPosition * uScale + uOffset;
  gl_Position = vec4(pos, 0.0, 1.0);
}\`;
const fragment = \`uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
}\`;
try {
  await fs.write("/dev/webgl/shader/vertex", vertex);
  await fs.write("/dev/webgl/shader/fragment", fragment);
  await fs.write("/dev/webgl/buffer/aPosition", "f32 -1 -1 1 -1 0 1");
  await fs.write("/dev/webgl/clearcolor", "0.05 0.15 0.05 1");
  await fs.write("/dev/webgl/uniform/2f/uScale", "0.6 0.6");
  for (let i = 0; i < 60; i++) {
    const t = i / 60;
    const off = (Math.sin(t * 6) * 0.5).toFixed(3) + " " + (Math.cos(t * 6) * 0.3).toFixed(3);
    const r = (0.5 + 0.5 * Math.sin(t * 6)).toFixed(3);
    const g = (0.5 + 0.5 * Math.sin(t * 6 + 2)).toFixed(3);
    const b = (0.5 + 0.5 * Math.sin(t * 6 + 4)).toFixed(3);
    await fs.write("/dev/webgl/uniform/2f/uOffset", off);
    await fs.write("/dev/webgl/uniform/3f/uColor", r + " " + g + " " + b);
    await fs.write("/dev/webgl/call", "clear");
    await fs.write("/dev/webgl/call", "draw arrays triangles 3 0");
    await fs.write("/dev/webgl/call", "swap");
    await new Promise((res) => setTimeout(res, 100));
  }
  console.log("webgldemo: drew 60 frames — see the canvas at the bottom-right.");
  console.log("Try: cat /dev/webgl/state · cat /dev/webgl/log · cp /dev/webgl/frame /tmp/shot.png");
} catch (e) {
  console.log("webgldemo: " + e.message);
  return 1;
}
`;
    syncWrite(this._getBackend("/commands/webgldemo.js"), "/webgldemo.js", webglDemoContent);

    // Audio device demo — plays a C-major scale + 440Hz drone via
    // /dev/audio. Browser only: needs a Web Audio API (run `audiodemo`).
    const audioDemoContent = `// audiodemo — play a tune via /dev/audio (browser only)
const notes = ["C4 0.25", "D4 0.25", "E4 0.25", "F4 0.25", "G4 0.25", "A4 0.25", "B4 0.25", "C5 0.5"];
try {
  await fs.write("/dev/audio/wave", "sine");
  await fs.write("/dev/audio/gain", "0.25");
  for (const n of notes) {
    await fs.write("/dev/audio/note", n);
    await new Promise((res) => setTimeout(res, 280));
  }
  await fs.write("/dev/audio/freq", "440");
  await fs.write("/dev/audio/on");
  await new Promise((res) => setTimeout(res, 1200));
  await fs.write("/dev/audio/off");
  console.log("audiodemo: played a C-major scale, then a 440Hz drone.");
  console.log("Try: echo 880 > /dev/audio/freq · echo square > /dev/audio/wave · echo A4 0.5 > /dev/audio/note");
  console.log("     cat /dev/audio/status · cp /dev/audio/frame /pc/tone.wav");
} catch (e) {
  console.log("audiodemo: " + e.message);
  return 1;
}
`;
    syncWrite(this._getBackend("/commands/audiodemo.js"), "/audiodemo.js", audioDemoContent);

    // Sample content for new users
    syncWrite(this._getBackend("/home/examples/README.txt"), "/examples/README.txt",
      `Welcome to tinysh!\n\n` +
      `Try these commands:\n` +
      `  ls /mount/github/gmatht/sh2perl  -- browse a GitHub repo\n` +
      `  cat /mount/github/gmatht/sh2perl/README.md  -- read a file\n` +
      `  mount github:gmatht/sh2perl /mymount  -- attach a repo at a path\n` +
      `  ls /git/github.com/torvalds/linux/  -- real git protocol, any repo\n` +
      `  cat /home/examples/hello.sh      -- a sample script\n` +
      `  edit /home/examples/note.txt     -- edit a file\n` +
      `  ls /dev/                         -- browser devices\n` +
      `  cat /dev/info                    -- system info\n` +
      `  ls /proc/                        -- processes + browser stats\n` +
      `  cat /proc/uptime · cat /proc/meminfo · cat /proc/browser\n`);
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

  mount(name, prefix, backend, opts = {}) {
    const record = { name, prefix, backend, ...opts };
    this.mounts.push(record);
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    return record;
  }

  // ─── mountSpec: mount a repo spec like "github:user/repo" ──
  // Used by the shell's `mount` builtin:
  //   mount github:user/repo /mymount
  // Returns the new mount record. User-created mounts are marked
  // .user so `unmount` can never detach a core mount by accident.
  mountSpec(spec, prefix) {
    const m = /^([a-z]+):(.+)$/.exec(String(spec).trim());
    if (!m) {
      throw new Error(`unknown mount spec '${spec}' (try 'github:user/repo')`);
    }
    const type = m[1];
    const arg = m[2];
    if (type === "github") {
      const parts = arg.split("/").filter(Boolean);
      if (parts.length < 2) {
        throw new Error(`github mount needs 'user/repo', got '${arg}'`);
      }
      const owner = parts[0];
      const repo = parts.slice(1).join("/");
      if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new Error(`invalid github repo '${arg}'`);
      }
      return this.mount(`github:${owner}/${repo}`, prefix,
        new OverlayFS(new GitHubRepoFS(owner, repo), "github", `fs:ovl:${prefix}:`),
        { user: true });
    }
    throw new Error(`unknown mount type '${type}' (supported: github)`);
  }

  // ─── unmount: detach a user-created mount ──────────────────
  // Only mounts created via mountSpec (.user) can be removed; core
  // mounts (/tmp, /home, /dev, ...) are protected.
  unmount(prefix) {
    const norm = prefix.replace(/\/+$/, "") || "/";
    const idx = this.mounts.findIndex((m) => m.prefix === norm && m.user);
    if (idx === -1) throw new Error("not a user mount");
    return this.mounts.splice(idx, 1)[0];
  }

  // Human-readable mount table, for `mount` / /proc/mounts
  mountTable() {
    const lines = this.mounts.map((m) =>
      `${m.prefix.padEnd(22)} ${m.name}${m.user ? "  (user)" : ""}`);
    return lines.join("\n") + "\n";
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
        return { backend: m.backend, relative, name: m.name };
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
    let result;
    if (m.backend.writeBlob) {
      result = await m.backend.writeBlob(m.relative, blob);
    } else {
      // Fallback: read blob as text and write
      const text = await blob.text();
      result = await m.backend.write(m.relative, text);
    }
    if (result && result.overlay) this._emitOverlayWarning(r, m.name);
    return result;
  }

  async write(path, content) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    const result = await m.backend.write(m.relative, content);
    if (result && result.overlay) this._emitOverlayWarning(r, m.name);
    return result;
  }

  async list(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    return m.backend.list(m.relative);
  }

  // Cache metadata ({ age, stale }) for a path's listing, or null if the
  // backend doesn't cache / has nothing cached. `ls` uses this to say
  // "cached 3h ago" instead of leaving the user guessing.
  async cacheInfo(path) {
    let r;
    try {
      r = this._resolve(path);
    } catch {
      return null;
    }
    const m = this._findBackend(r);
    if (!m || !m.backend.cacheInfo) return null;
    return m.backend.cacheInfo(m.relative);
  }

  // API rate-limit usage ({ name, limit, remaining }) for a path's
  // backend, or null. Only meaningful right after a fresh (network)
  // listing — cached listings return null.
  async rateInfo(path) {
    let r;
    try {
      r = this._resolve(path);
    } catch {
      return null;
    }
    const m = this._findBackend(r);
    if (!m || !m.backend.rateInfo) return null;
    return m.backend.rateInfo();
  }

  async remove(path) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    const result = await m.backend.remove(m.relative);
    if (result && result.overlay) this._emitOverlayWarning(r, m.name);
    return result;
  }

  // Overlay writes (read-only mounts) surface a warning via this hook.
  // The shell sets it to print the fork/login notice.
  _emitOverlayWarning(path, mountName) {
    if (this.onOverlayWrite) this.onOverlayWrite(path, mountName);
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

    // Classify entries for coloring: dirs → blue, executable files
    // (.js/.mjs/.wasm — the formats this shell runs) → green, other
    // files → white. stat is best-effort: remote/virtual backends may
    // not support it, so fall back to the trailing-slash convention.
    const kinds = [];
    for (const e of entries) {
      let kind = "file";
      try {
        const st = await this.stat(path + "/" + e);
        if (st && st.type === "dir") kind = "dir";
        else if (st && st.type === "file" && isExecutableName(e)) kind = "exe";
      } catch {
        if (e.endsWith("/")) kind = "dir";
      }
      kinds.push(kind);
    }

    // Column count adapts to the terminal width when the caller passes
    // one (the browser shell does); otherwise default to 4 columns.
    const widths = entries.map(e => e.length);
    const colW = Math.max(...widths) + 2;
    const cols = opts.width
      ? Math.max(1, Math.floor(opts.width / colW))
      : Math.max(1, opts.cols || 4);
    const rows = [];
    for (let i = 0; i < entries.length; i += cols) {
      rows.push(
        entries.slice(i, i + cols)
          .map((e, j) => {
            const name = colorize(e, kinds[i + j]);
            // Pad on the *visible* length so ANSI codes don't misalign columns
            return j === cols - 1 ? name : name + " ".repeat(Math.max(0, colW - e.length));
          })
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
      const exe = type === "file" && isExecutableName(name);
      rows.push({
        mode: type === "dir" ? "drwxr-xr-x" : exe ? "-rwxr-xr-x" : "-rw-r--r--",
        size,
        date: formatMtime(mtime),
        name: colorize(name, type === "dir" ? "dir" : exe ? "exe" : "file"),
      });
    }
    const sizeW = Math.max(...rows.map(r => String(r.size).length));
    const dateW = Math.max(...rows.map(r => r.date.length));
    return rows.map(r =>
      `${r.mode} 1 tinysh tinysh ${String(r.size).padStart(sizeW)} ${r.date.padEnd(dateW)} ${r.name}`
    ).join("\n") + "\n";
  }
}

// ─── ls colors ─────────────────────────────────────────────────
// ANSI SGR codes: directories blue, executable files green, plain
// files white (the terminal renders the escapes; browsers map them
// to their palette in www/index.html).
const ANSI = {
  blue: "\x1b[34m",
  green: "\x1b[32m",
  white: "\x1b[37m",
  reset: "\x1b[0m",
};

// An entry is "executable" if the shell can run it directly: .js/.mjs
// command scripts or .wasm binaries (the virtual machine's native
// binary format).
function isExecutableName(name) {
  return /\.(js|mjs|wasm)$/i.test(name);
}

// Wrap a name in its color code. Callers pad using the raw (visible)
// length so the invisible escapes never shift the columns.
function colorize(name, kind) {
  const code = kind === "dir" ? ANSI.blue : kind === "exe" ? ANSI.green : ANSI.white;
  return `${code}${name}${ANSI.reset}`;
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
