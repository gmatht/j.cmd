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
//   /bin/         → LocalStorageFS(.js commands — the shell's binaries)
//   /commands/    → (alias of /bin — legacy name)
//   /usr/bin/     → RamFS         (WASM binaries: wasmer install, auto-load)
//   /http/        → HttpFS        (CORS fetch access; ls shows featured samples)
//   /proc/        → ProcFS        (process info + browser stats)
//   /dev/         → DevFS         (browser devices)
//   /pc/          → DownloadFS    (downloads)
//   /mount/github → GitHubFS      (GitHub API as a filesystem)
//   /mount/gitlab → GitLabFS      (GitLab API as a filesystem)
//   /mount/git    → GitFS         (real git wire protocol over HTTP)
// -------------------------------------------------------------------

import { env } from "../env.js";
import { DocsFS } from "./docsfs.js";
import { RamFS } from "./ramfs.js";
import { LocalStorageFS } from "./localstoragefs.js";
import { IndexedDBFS } from "./indexeddbfs.js";
import { HttpFS } from "./httpfs.js";
import { GitHubFS, GitHubRepoFS } from "./githubfs.js";
import { GitLabFS } from "./gitlabfs.js";
import { GitFS } from "./gitfs.js";
import { DevFS } from "./devfs.js";
import { DownloadFS } from "./downloadfs.js";
import { ZipFS } from "./zipfs.js";
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

// ─── One-time migration for the LocalStorageFS namespace split ──
// v1 stored every local mount in ONE flat keyspace (fs:file:...), so
// /home and /bin — two LocalStorageFS instances — listed the same
// files: every /bin command showed up in /home and hello.txt/.jtshrc
// showed up in /bin. v2 gives each mount its own namespace
// (fs:home:file:..., fs:bin:file:...). Move existing keys there:
// top-level *.js files are commands → bin; everything else → home.
// .welcome was a write-only seed (nothing ever read it) — drop it.
// The shared dirs index and mtimes are rebuilt from scratch.
const LEGACY_MIGRATED_KEY = "fs:migrated:v2";
function migrateLegacyLocalStorage() {
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(LEGACY_MIGRATED_KEY) !== null) return;
  const legacyKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("fs:file:")) legacyKeys.push(k);
  }
  if (legacyKeys.length === 0) {
    localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
    return;
  }
  const home = new LocalStorageFS("home");
  const bin = new LocalStorageFS("bin");
  for (const key of legacyKeys) {
    const p = key.slice("fs:file:".length);
    const data = localStorage.getItem(key);
    if (data === null) continue;
    const top = p.replace(/^\/+/, "");
    if (top === "" || top === ".welcome") {
      localStorage.removeItem(key); // .welcome was write-only — drop it
      continue;
    }
    // Commands live at the top level and are .js files — /bin material.
    if (!top.includes("/") && top.endsWith(".js")) bin.write(p, data);
    else home.write(p, data);
    localStorage.removeItem(key); // the key moved to its namespaced home
  }
  // The shared v1 dirs index and mtimes are superseded by per-namespace ones.
  localStorage.removeItem("fs:.dirs");
  localStorage.removeItem("fs:meta");
  localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
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

  // Synchronous stat — overlay writes first, then the backend's statSync
  // (local mounts only; sh2.test file tests use this).
  statSync(path) {
    if (this.files.has(path)) {
      const c = this.files.get(path);
      if (c === WHITEOUT) throw new Error("ENOENT");
      const text = c.startsWith(B64) ? c.slice(B64.length) : c;
      return { type: "file", size: text.length, mtime: Date.now() };
    }
    return this.backend.statSync ? this.backend.statSync(path) : null;
  }
}

// ─── BindFS: re-expose one subtree at another path ─────────────
// `mount --bind src dst` wraps the src backend with a path prefix, so
// dst/X reads/writes src/X. Permissions follow the ORIGINAL paths (the
// VirtualFS translates bind dsts back before checking attrs).
class BindFS {
  constructor(base, prefix) {
    this.base = base;      // the backend hosting src (e.g. LocalStorageFS)
    this.prefix = prefix;  // relative base inside it (e.g. "/nobody")
  }
  _p(p) {
    const rel = p === "/" || p === "" ? "" : p.replace(/^\/+/, "");
    return this.prefix + "/" + rel;
  }
  read(p) { return this.base.read(this._p(p)); }
  readBlob(p) { return this.base.readBlob ? this.base.readBlob(this._p(p)) : this.base.read(this._p(p)); }
  write(p, c) { return this.base.write(this._p(p), c); }
  writeBlob(p, b) {
    if (this.base.writeBlob) return this.base.writeBlob(this._p(p), b);
    return this.base.write(this._p(p), typeof b === "string" ? b : b.text());
  }
  list(p) { return this.base.list(this._p(p)); }
  remove(p) { return this.base.remove(this._p(p)); }
  stat(p) { return this.base.stat ? this.base.stat(this._p(p)) : null; }
  statSync(p) { return this.base.statSync ? this.base.statSync(this._p(p)) : null; }
}

// ─── VirtualFS ─────────────────────────────────────────────────

class VirtualFS {
  constructor() {
    // v1 stored /home and /bin in one flat keyspace — split it once
    // (before seeding, so version-gated command writes see migrated files)
    migrateLegacyLocalStorage();
    this.mounts = [];
    this.zipCache = new Map();      // zip path → parsed ZipFS promise (or null)
    this.autoUnmounted = new Set(); // zips the user explicitly unmounted this session
    this.cwd = "/home";
    // Ownership + mode bits, enforced at this layer: every command
    // reaches the filesystem only through VirtualFS, so `su nobody`
    // really cannot read a 0600 file owned by jtsh. In-memory only —
    // a reload re-creates the world as the admin user, which is
    // exactly what happens on a real boot.
    this.attrs = new Map();  // resolved path → { owner, mode }
    this.binds = new Map();  // bind-mount dst → original real path
    // Symlinks live at the VFS layer (not in any backend), keyed by the
    // view-space path of the link itself → target (absolute or relative,
    // as given to ln). Reads/writes/stats follow them through _resolve;
    // listings merge them in; rm unlinks them without touching targets.
    // In-memory only, like attrs — a reload re-creates the world.
    this.links = new Map();
    this.root = "/";         // chroot root (view-space "/" maps here)
    this.chrootSavedCwd = null;

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
    // /home and /bin are separate stores (namespaced keys), so /bin's
    // .js commands don't show up in /home and home files don't list in
    // /bin — before the namespace split they shared one keyspace.
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/home",
      hasLocalStorage ? new LocalStorageFS("home") : new RamFS());
    // /bin — the shell's binaries. JavaScript is the binary format, so
    // user/system .js commands live here (persistent). /commands is kept
    // as an alias mount so old paths and existing files keep working.
    const commands = hasLocalStorage ? new LocalStorageFS("bin") : new RamFS();
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/bin", commands);
    this.mount(hasLocalStorage ? "localStorage" : "ram", "/commands", commands);
    // /usr/bin — real WASM binaries (wasmer install, auto-load). RamFS:
    // python.wasm etc. would blow the ~5MB localStorage quota, and they
    // re-download from the local server on boot anyway.
    this.mount("ram", "/usr/bin", new RamFS());
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
    // The repo's own documentation, readable from inside the shell.
    this.mount("docs", "/docs", new OverlayFS(new DocsFS(), "docs", "fs:ovl:docs:"));
    this.mount("download", "/pc", new DownloadFS());
    // /proc/ — process info + browser stats. ProcFS keeps a registry of
    // every command jtsh runs (procfs.start/finish) and generates the
    // rest of the files from browser APIs (hardwareConcurrency, device-
    // Memory, performance.memory, navigation timing, mount table, ...).
    this.mount("proc", "/proc", procfs);
    procfs.setVfs(this);
    // IndexedDB-backed persistent store for large files — unlike
    // localStorage's ~5MB per-origin quota, IndexedDB has no practical
    // size limit, so /big/ is where files that outgrow /home/ belong.
    this.mount(hasIndexedDB ? "indexedDB" : "ram", "/big",
      hasIndexedDB ? new IndexedDBFS() : new RamFS());

    // Initialize default files
    if (hasLocalStorage && !localStorage.getItem("fs:initialized")) {
      localStorage.setItem("fs:initialized", "1");
      // hello.txt is the canonical example file (md5sum/sha256sum man
      // pages reference it). The old .welcome seed was write-only —
      // nothing ever read it — so it's gone.
      syncWrite(this._getBackend("/home/hello.txt"), "/hello.txt",
        "Hello from localStorage! This survives reload.\n");
    } else if (!hasLocalStorage) {
      // No localStorage (Node.js), write init files to RamFS
      syncWrite(this._getBackend("/home/hello.txt"), "/hello.txt",
        "Hello from RamFS! Contents lost on restart.\n");
    }
    // Sample startup config — read by the shell at startup (interactive
    // mode). All lines here are commented out so first-run behaviour is
    // unchanged; uncomment to try the feature.
    const sampleRc =
      "# ~/.jtshrc — jtsh startup config (read at shell startup)\n" +
      "# Each line is run as a shell command; '#' starts a comment.\n" +
      "# Uncomment to try:\n" +
      "# export EDITOR=edit\n" +
      "# export PATH=/bin:/usr/bin\n" +
      "# echo \"Welcome back to jtsh!\"\n";
    syncWrite(this._getBackend("/home/.jtshrc"), "/.jtshrc", sampleRc);
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

        // Pre-populate commands: the /bin command files (perl, lua, tar,
    // zip, mail, screen, llm, … ~184 KB of source) are NOT embedded
    // here anymore. Their templates live in www/bin/*.js and are
    // materialized into /bin on first use (src/binsync.js) — cutting
    // them out of this bundle and deferring the localStorage writes
    // to when each command is actually run.

// Sample content for new users
    syncWrite(this._getBackend("/home/examples/README.txt"), "/examples/README.txt",
      `Welcome to jtsh!\n\n` +
      `Try these commands:\n` +
      `  ls /mount/github/gmatht/sh2perl  -- browse a GitHub repo\n` +
      `  cat /mount/github/gmatht/sh2perl/README.md  -- read a file\n` +
      `  mount github:gmatht/sh2perl /mymount  -- attach a repo at a path\n` +
      `  ls /git/github.com/torvalds/linux/  -- real git protocol, any repo\n` +
      `  cat /home/examples/hello.sh      -- a sample script\n` +
      `  python /home/examples/sample.py  -- run a Python script\n` +
      `  perl /home/examples/sample.pl    -- run a Perl script\n` +
      `  lua /home/examples/sample.lua    -- run a Lua script\n` +
      `  cc /home/examples/sample.c && ./a.wasm  -- compile & run C\n` +
      `  edit /home/examples/note.txt     -- edit a file\n` +
      `  ls /home/examples/               -- includes symlinked sample files\n` +
      `  cat /home/examples/sample.txt    -- a sample text file (via symlink)\n` +
      `  ls -l /home/examples/sample.mp3  -- a symlink into /http/\n` +
      `  cd /home/examples/sample.zip && ls && cat Hello.txt  -- browse a zip\n` +
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

    // Sample programs in the languages the shell can run. Run them from
    // the file grid's long-press menu (Run), or type the command:
    //   python sample.py · perl sample.pl · lua sample.lua
    //   tcc sample.c && ./a.wasm   (in-shell C compiler — wasm32 tcc)
    //   cc sample.c && ./a.wasm    (cproc → QBE → wasm)
    syncWrite(this._getBackend("/home/examples/sample.c"), "/examples/sample.c",
`/* sample.c - compile & run:  tcc sample.c && ./a.wasm
   (or cc sample.c && ./a.wasm — the cproc pipeline) */
#include <stdio.h>

int main(void) {
    printf("Hello from C! %d\\n", 2024);
    int total = 0;
    for (int i = 1; i <= 10; i++) total += i;
    if (total == 55) {
        puts("sum 1..10 = 55");
        return 0;
    }
    puts("wrong!");
    return 1;
}
`);
    syncWrite(this._getBackend("/home/examples/sample.py"), "/examples/sample.py",
`# sample.py — run with:  python sample.py
total = 0
for i in range(1, 11):
    total += i
    print("i = {:2d}, running total = {:2d}".format(i, total))
print("sum 1..10 =", total)
`);
    syncWrite(this._getBackend("/home/examples/sample.pl"), "/examples/sample.pl",
`# sample.pl — run with:  perl sample.pl
my $total = 0;
for my $i (1 .. 10) {
    $total += $i;
    printf "i = %2d, running total = %2d\\n", $i, $total;
}
print "sum 1..10 = $total\\n";
`);
    syncWrite(this._getBackend("/home/examples/sample.lua"), "/examples/sample.lua",
`-- sample.lua — run with:  lua sample.lua
local total = 0
for i = 1, 10 do
  total = total + i
  print(string.format("i = %2d, running total = %2d", i, total))
end
print("sum 1..10 = " .. total)
`);

    // Sample files, one per common file type — symlinks into /http/'s
    // featured CORS-enabled archives. Symlinks live in the VFS layer,
    // so this is cheap, crosses mounts, and never copies bytes; they're
    // re-created at every boot like /usr/bin's wasm binaries. Removing
    // one (`rm /home/examples/sample.mp3`) unlinks it without touching
    // the remote file. cat/play/cp work straight through the link.
    //
    // Sources chosen for CORS stability: archive.org's big-video nodes
    // (dn*.ca.archive.org) don't send CORS, so videos come from
    // Wikimedia Commons and GitHub Pages instead.
    this._linkSync("/http/raw.githubusercontent.com/mdn/webaudio-examples/main/audio-analyser/viper.mp3", "/home/examples/sample.mp3");
    this._linkSync("/http/upload.wikimedia.org/wikipedia/commons/d/db/Alligatorbellowedit.ogg", "/home/examples/sample.ogg");
    // Video samples: mp4 (H.264) and webm (VP9) play in every browser.
    this._linkSync("/http/upload.wikimedia.org/wikipedia/commons/c/c1/Diehl_Wecker_%28ca._1955%29.webm", "/home/examples/sample.webm");
    this._linkSync("/http/upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png", "/home/examples/sample.png");
    this._linkSync("/http/picsum.photos/id/237/200/300", "/home/examples/sample.jpg");
    this._linkSync("/http/mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4", "/home/examples/sample.mp4");
    this._linkSync("/http/raw.githubusercontent.com/git/git/master/README.md", "/home/examples/sample.txt");
    // Zip archives mount lazily as directories — cd into this one.
    this._linkSync("/http/raw.githubusercontent.com/Stuk/jszip/main/test/ref/all.zip", "/home/examples/sample.zip");
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
    const record = this.mounts.splice(idx, 1)[0];
    // A detached zip must not auto-remount on the next access.
    if (record.zip) this.zipUnmounted(norm);
    return record;
  }

  // ─── zip mounts: cd into .zip files ──────────────────────────
  // Any path component ending in .zip that resolves to a real ZIP file
  // becomes a mount at that path (an OverlayFS over a read-only ZipFS,
  // so writes inside the mounted dir land in the overlay — never the
  // archive). Mounts are created lazily on first access; nested zips
  // (a.zip/b.zip) mount recursively. The archive file itself stays
  // readable: read/readBlob at exactly the mount point return the RAW
  // bytes from the underlying backend (see _findBackendRaw).

  _hasMount(prefix) {
    return this.mounts.some((m) => m.prefix === prefix);
  }

  // Parse-cached ZipFS for a resolved path, or null when it isn't a
  // readable zip (missing, a dir, or junk bytes). The cache means a zip
  // is read and parsed at most once per session; _dropZipMount clears
  // it when the archive is replaced.
  async _zipForFile(resolvedPath) {
    if (!this.zipCache.has(resolvedPath)) {
      this.zipCache.set(resolvedPath, this._zipForFileSlow(resolvedPath));
    }
    return this.zipCache.get(resolvedPath);
  }

  async _zipForFileSlow(resolvedPath) {
    const m = this._findBackendRaw(resolvedPath);
    if (!m) return null;
    let st;
    try { st = await m.backend.stat(m.relative); } catch { return null; }
    if (!st || st.type !== "file") return null;
    let bytes;
    try {
      if (m.backend.readBlob) {
        const blob = await m.backend.readBlob(m.relative);
        bytes = new Uint8Array(await blob.arrayBuffer());
      } else {
        bytes = new TextEncoder().encode(await m.backend.read(m.relative));
      }
    } catch { return null; }
    try {
      const zipfs = new ZipFS(bytes);
      zipfs._parse();   // throws if the bytes aren't a zip
      return zipfs;
    } catch { return null; }
  }

  // Mount every .zip component of a resolved path that isn't mounted
  // yet (so /a.zip/sub/b.zip works for nested archives). Cheap once
  // mounted: the walk stops at existing mounts.
  async _ensureZipMounts(resolvedPath) {
    const parts = resolvedPath.split("/").filter(Boolean);
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? prefix + "/" + parts[i] : "/" + parts[i];
      if (!/\.zip$/i.test(parts[i])) continue;
      if (this.autoUnmounted.has(prefix)) continue;
      if (this._hasMount(prefix)) continue;
      const zipfs = await this._zipForFile(prefix);
      if (!zipfs) continue;
      this.mount("zip:" + prefix, prefix,
        new OverlayFS(zipfs, "zip", `fs:ovl:zip:${prefix}:`),
        { user: true, zip: true });
    }
  }

  // The archive itself was replaced or removed — detach its mount and
  // drop the parse cache so the next access re-reads the file.
  _dropZipMount(resolvedPath) {
    const idx = this.mounts.findIndex((m) => m.prefix === resolvedPath && m.zip);
    if (idx !== -1) this.mounts.splice(idx, 1);
    this.zipCache.delete(resolvedPath);
  }

  // The shell's `unmount` builtin calls this for zip mounts so a
  // detached archive stays detached (it would otherwise auto-remount
  // on the next access).
  zipUnmounted(resolvedPath) {
    this.autoUnmounted.add(resolvedPath);
    this.zipCache.delete(resolvedPath);
  }

  // True when path resolves to exactly a mounted .zip archive (so cat
  // can say "cd into it" instead of a generic binary hint).
  async isZipMount(path) {
    const r = this._resolve(path);
    await this._ensureZipMounts(r);
    return this.mounts.some((m) => m.zip && m.prefix === r);
  }

  // Human-readable mount table, for `mount` / /proc/mounts
  mountTable() {
    const lines = this.mounts.map((m) =>
      `${m.prefix.padEnd(22)} ${m.name}${m.user ? "  (user)" : ""}`);
    return lines.join("\n") + "\n";
  }

  // ─── permissions ─────────────────────────────────────────────
  _user() { return (env && env.USER) || "jtsh"; }
  _isAdmin(user) { return user === "jtsh" || user === "root"; }
  _parent(path) {
    const p = path.replace(/\/+$/, "");
    if (p === "" || p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i === 0 ? "/" : p.slice(0, i);
  }
  // Owner/mode for a resolved path; unknown paths default to the admin's
  // 0755 (legacy files stay accessible; new files get recorded attrs).
  _attrFor(path) {
    const a = this.attrs.get(this._orig(path));
    return a || { owner: "jtsh", mode: 0o755 };
  }
  _setAttr(path, attr) { this.attrs.set(path, attr); }
  // attrOf/setAttr are the shell's public API (chmod).
  attrOf(path) {
    let r;
    try { r = this._resolve(path); } catch { return null; }
    return this.attrs.get(r) || null;
  }
  setAttr(path, attr) {
    this._setAttr(this._resolve(path), attr);
  }
  _can(path, op) {
    const user = this._user();
    if (this._isAdmin(user)) return true;
    const a = this._attrFor(path);
    const owner = user === a.owner;
    const bit = op === "w" ? (owner ? 0o200 : 0o002)
               : op === "x" ? (owner ? 0o100 : 0o001)
               : (owner ? 0o400 : 0o004);
    return (a.mode & bit) !== 0;
  }
  _check(path, op) {
    if (!this._can(path, op)) {
      throw new Error(`EACCES: permission denied: ${path}`);
    }
  }
  _ensureParentAttrs(path, owner) {
    let p = this._parent(path);
    while (p !== "/" && !this.attrs.has(p)) {
      this.attrs.set(p, { owner, mode: 0o755 });
      p = this._parent(p);
    }
  }

  // Resolve a path: cwd-join, . / .. normalization, chroot mapping —
  // and symbolic links. Links are followed as components are walked;
  // absolute targets restart the walk from root, relative targets
  // resolve against the link's own directory. A guard counter stops
  // link loops at the POSIX limit of 40 hops (ELOOP).
  //
  // opts.followFinal=false leaves the LAST component unresolved when it
  // is a link, so callers can address the link itself (readlink, rm,
  // ln, ls -l). Intermediate links are still followed.
  _resolve(path, opts = {}) {
    const followFinal = opts.followFinal !== false;
    let resolved = path;
    if (!path.startsWith("/")) {
      resolved = (this.cwd === "/" ? "/" : this.cwd + "/") + path;
    }
    let parts = resolved.split("/").filter(Boolean);
    const out = [];
    let guard = 0;
    while (parts.length > 0) {
      const p = parts.shift();
      if (p === "..") { out.pop(); continue; }
      if (p === ".") continue;
      const cur = "/" + out.concat(p).join("/");
      if (this.links.has(cur)) {
        const isFinal = parts.length === 0;
        if (isFinal && !followFinal) {
          // Stop at the link itself (readlink/rm/ls -l want the link).
          out.push(p);
          continue;
        }
        if (++guard > 40) {
          throw new Error("ELOOP: too many levels of symbolic links");
        }
        const target = this.links.get(cur);
        const tparts = target.split("/").filter(Boolean);
        if (target.startsWith("/")) {
          // Absolute target: restart the walk from the target's root.
          out.length = 0;
          parts = tparts.concat(parts);
        } else {
          // Relative target: resolves against the link's directory,
          // which is exactly what `out` holds at this point.
          parts = tparts.concat(parts);
        }
        continue;
      }
      out.push(p);
    }
    let norm = "/" + out.join("/");
    // chroot: view-space absolute paths map into the confined root.
    if (this.root && this.root !== "/") {
      norm = this.root.replace(/\/+$/, "") + (norm === "/" ? "" : norm);
    }
    return norm;
  }

  // Map a real path back into the chroot view (for prompts / pwd).
  view(path) {
    if (!this.root || this.root === "/") return path;
    if (path === this.root) return "/";
    if (path && path.startsWith(this.root + "/")) return path.slice(this.root.length);
    return path;
  }

  // Bind-mount src (a real resolved path) at dst. Admin-only; the dst
  // prefix is registered so permission checks translate back to the
  // original paths (bind mounts never bypass ownership/mode).
  bindMount(src, dst) {
    const m = this._findBackend(src);
    if (!m) throw new Error(`ENOENT: ${src}`);
    const wrapper = new BindFS(m.backend, m.relative.replace(/\/$/, ""));
    this.mount("bind", dst, wrapper, { user: true });
    this.binds.set(dst, src);
  }

  // Translate a bind-mount dst back to the original real path.
  _orig(r) {
    if (this.binds.size === 0) return r;
    for (const [dst, src] of this.binds) {
      if (r === dst) return src;
      if (r.startsWith(dst + "/")) return src + r.slice(dst.length);
    }
    return r;
  }

  _findBackend(resolvedPath) {
    for (const m of this.mounts) {
      if (resolvedPath.startsWith(m.prefix)) {
        let relative = resolvedPath.slice(m.prefix.length) || "/";
        // Ensure relative path always starts with "/" — when the matching
        // prefix is "/" (root), the slice strips it and we lose the leading
        // slash unless we re-add it.
        if (!relative.startsWith("/")) relative = "/" + relative;
        return { backend: m.backend, relative, name: m.name, zip: m.zip, prefix: m.prefix };
      }
    }
    return null;
  }

  // Backend for a path, skipping zip mounts — used to read the RAW
  // archive bytes of a .zip that is itself a mount point (the mount
  // makes it a directory for browsing; copying the archive still works).
  _findBackendRaw(resolvedPath) {
    for (const m of this.mounts) {
      if (m.zip) continue;
      if (resolvedPath.startsWith(m.prefix)) {
        let relative = resolvedPath.slice(m.prefix.length) || "/";
        if (!relative.startsWith("/")) relative = "/" + relative;
        return { backend: m.backend, relative, name: m.name };
      }
    }
    return null;
  }

  // ─── symlinks ────────────────────────────────────────────────
  // Links are VFS-level state (this.links), keyed by view-space path.
  // They can point anywhere — /home files, /http/ URLs, /github repos,
  // relative or absolute — and never copy bytes. Reads/writes/stat
  // follow them via _resolve; listings merge them; remove unlinks them.

  // Is this path itself a symlink (without following)? Sync + cheap —
  // the listing code calls it per entry without ever touching targets.
  _isLink(path) {
    try {
      const r = this._resolve(path, { followFinal: false });
      return this.links.has(this.view(r));
    } catch {
      return false;
    }
  }

  // Target of the link at this path, or null if it's not a symlink.
  _readlinkTarget(path) {
    try {
      const r = this._resolve(path, { followFinal: false });
      const t = this.links.get(this.view(r));
      return t === undefined ? null : t;
    } catch {
      return null;
    }
  }

  // Create a symlink (synchronous core — used at boot to prepopulate
  // the sample-file links before any await can run).
  _linkSync(target, linkpath) {
    const r = this._resolve(linkpath, { followFinal: false });
    const parent = this._parent(r);
    this._check(parent, "w");
    this._check(parent, "x");
    if (!this._findBackend(r)) {
      throw new Error(`ENOENT: ${linkpath} (no mount for ${r})`);
    }
    const key = this.view(r);
    this.links.set(key, target);
    // Links get an attribute too so ls -l shows a real owner; mode 777
    // like Linux (the mode is decorative — access goes through the
    // target's own attrs once followed).
    if (!this.attrs.has(key)) this.attrs.set(key, { owner: this._user(), mode: 0o777 });
    return { link: true, target };
  }

  // Public API: create a symlink at linkpath pointing at target.
  // The parent directory must exist (like real ln) and the destination
  // must not already exist (use rm first, or `ln -f` in the shell).
  async link(target, linkpath) {
    const r = this._resolve(linkpath, { followFinal: false });
    const parent = this._parent(r);
    try {
      await this.list(parent);
    } catch {
      throw new Error(`ENOENT: ${linkpath} (no such directory)`);
    }
    try {
      await this.stat(linkpath);
      throw new Error(`EEXIST: ${linkpath}`);
    } catch (e) {
      if (!e.message.startsWith("ENOENT")) throw e;
    }
    return this._linkSync(target, linkpath);
  }

  // Target of the symlink at path, or throw EINVAL if it isn't one.
  async readlink(path) {
    const t = this._readlinkTarget(path);
    if (t === null) throw new Error("EINVAL: not a symbolic link");
    return t;
  }

  async read(path) {
    const r = this._resolve(path);
    await this._ensureZipMounts(r);
    this._check(this._parent(r), "x");
    this._check(r, "r");
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    // A .zip that is itself a mount point: the mount makes it a
    // directory for browsing, but reading the archive returns the raw
    // bytes (cp /pc, zip -l/-x, downloads still work).
    if (m.zip && r === m.prefix) {
      const raw = this._findBackendRaw(r);
      if (raw) return raw.backend.read(raw.relative);
    }
    return m.backend.read(m.relative);
  }

  async readBlob(path) {
    const r = this._resolve(path);
    await this._ensureZipMounts(r);
    this._check(this._parent(r), "x");
    this._check(r, "r");
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    if (m.zip && r === m.prefix) {
      const raw = this._findBackendRaw(r);
      if (raw) {
        if (raw.backend.readBlob) return raw.backend.readBlob(raw.relative);
        const text = await raw.backend.read(raw.relative);
        return new Blob([text], { type: "application/octet-stream" });
      }
    }
    if (m.backend.readBlob) {
      return m.backend.readBlob(m.relative);
    }
    const text = await m.backend.read(m.relative);
    return new Blob([text], { type: "text/plain" });
  }

  // For a write/remove on a resolved path: if the target IS the
  // archive itself (a .zip not inside another zip mount), detach its
  // mount so the operation reaches the real file (regenerating or
  // deleting a zip re-mounts on next access); otherwise ensure zip
  // mounts exist (writes inside an archive go to its overlay).
  async _ensureZipTarget(resolvedPath) {
    const name = resolvedPath.split("/").filter(Boolean).pop() || "";
    const insideZip = this.mounts.some((m) =>
      m.zip && m.prefix !== resolvedPath && resolvedPath.startsWith(m.prefix + "/"));
    if (/\.zip$/i.test(name) && !insideZip) {
      this._dropZipMount(resolvedPath);
      return;
    }
    await this._ensureZipMounts(resolvedPath);
  }

  async writeBlob(path, blob) {
    const r = this._resolve(path);
    await this._ensureZipTarget(r);
    this._check(this._parent(r), "x");
    if (this.attrs.has(r)) this._check(r, "w");
    else this._check(this._parent(r), "w");
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
    this._recordWrite(r);
    return result;
  }

  async write(path, content) {
    const r = this._resolve(path);
    await this._ensureZipTarget(r);
    this._check(this._parent(r), "x");
    if (this.attrs.has(r)) this._check(r, "w");
    else this._check(this._parent(r), "w");
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    const result = await m.backend.write(m.relative, content);
    if (result && result.overlay) this._emitOverlayWarning(r, m.name);
    this._recordWrite(r);
    return result;
  }

  // Streaming write: backends that support it (DownloadFS via StreamSaver)
  // return a WritableStream you write Uint8Array chunks to; the download
  // starts as you write and never sits fully in memory. Other backends
  // throw — callers fall back to building the bytes and writeBlob.
  async writeStream(path, opts = {}) {
    const r = this._resolve(path);
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    if (m.backend.writeStream) return m.backend.writeStream(m.relative, opts);
    throw new Error(`EROFS: ${path}: ${m.name} cannot stream writes`);
  }

  // After a successful write: attribute the file (and any parent dirs
  // the backends auto-created) to the current user.
  _recordWrite(r) {
    const orig = this._orig(r);
    const owner = this._user();
    if (!this.attrs.has(orig)) this.attrs.set(orig, { owner, mode: 0o644 });
    this._ensureParentAttrs(orig, owner);
  }

  async list(path) {
    const r = this._resolve(path);
    await this._ensureZipMounts(r);
    this._check(this._parent(r), "x");
    this._check(r, "r");
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    const entries = await m.backend.list(m.relative);
    // Symlinks live above the backends, so a directory listing must add
    // the links whose parent is this directory.
    const v = this.view(r);
    const prefix = v === "/" ? "/" : v + "/";
    const extra = [];
    for (const key of this.links.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
        extra.push(key.slice(prefix.length));
      }
    }
    if (extra.length === 0) return entries;
    // Merge and sort; keep "..." (truncation marker) pinned last like
    // the backends' own convention.
    const merged = [...new Set([...entries, ...extra])];
    return merged.sort((a, b) => {
      const ea = a === "..." ? 1 : 0;
      const eb = b === "..." ? 1 : 0;
      return (ea - eb) || (a < b ? -1 : a > b ? 1 : 0);
    });
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
    // If the path names a symlink, unlink the link itself — never the
    // target (real rm semantics; rm /home/link must not delete the
    // file it points at).
    const linkRes = this._resolve(path, { followFinal: false });
    const linkKey = this.view(linkRes);
    if (this.links.has(linkKey)) {
      this._check(this._parent(linkRes), "w");
      this._check(this._parent(linkRes), "x");
      this.links.delete(linkKey);
      this.attrs.delete(linkKey);
      return { link: true };
    }
    const r = this._resolve(path);
    await this._ensureZipTarget(r);
    this._check(this._parent(r), "w");
    this._check(this._parent(r), "x");
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    const result = await m.backend.remove(m.relative);
    // If a directory was removed, backends know nothing of the links
    // that lived inside it — drop them here.
    const v = this.view(r);
    if (v !== "/") {
      for (const key of [...this.links.keys()]) {
        if (key.startsWith(v + "/")) this.links.delete(key);
      }
    }
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
    await this._ensureZipMounts(r);
    // stat is metadata: needs traverse (x) on the parent, not read on
    // the file — `ls -l` shows real modes even when the content is
    // private, exactly like Unix.
    this._check(this._parent(r), "x");
    const m = this._findBackend(r);
    if (!m) throw new Error(`ENOENT: ${path} (no mount for ${r})`);
    let st;
    if (m.backend.stat) {
      st = await m.backend.stat(m.relative);
    } else {
      try {
        const content = await m.backend.read(m.relative);
        st = { type: "file", size: content.length, mtime: undefined };
      } catch (e) {
        const msg = e.message || "";
        if (msg.includes("EISDIR") || msg.includes("ENOTDIR")) {
          st = { type: "dir", size: 0, mtime: undefined };
        } else {
          throw e;
        }
      }
    }
    const a = this._attrFor(r);
    return { ...st, owner: a.owner, mode: a.mode };
  }

  // Synchronous stat, or null when the backend can't do it synchronously
  // (remote mounts, missing file). sh2.test's file tests rely on this.
  statSync(path) {
    try {
      const r = this._resolve(path);
      if (!this._can(this._parent(r), "x")) return null;
      const m = this._findBackend(r);
      if (!m || !m.backend.statSync) return null;
      const st = m.backend.statSync(m.relative);
      const a = this._attrFor(r);
      return { ...st, owner: a.owner, mode: a.mode };
    } catch {
      return null;
    }
  }

  // ─── formatList: human-readable directory listing ───────────

  async formatList(path, opts = {}) {
    const entries = await this.list(path);
    if (entries.length === 0) return "";
    if (opts.long) return await this.formatLongList(path, entries);

    // Classify entries for coloring: dirs → blue, executable files
    // (.js/.mjs/.wasm — the formats this shell runs) → green, other
    // files → white. Every backend marks directories with a trailing
    // slash, so dirs need no stat — and on GitHub a stat is an API call
    // per entry, so short listings must not burn quota on them. stat is
    // best-effort for files: remote/virtual backends may not support it
    // (stat returns null), so fall back to the trailing-slash
    // convention.
    const kinds = [];
    for (const e of entries) {
      let kind = "file";
      if (e.endsWith("/")) {
        kind = "dir";
      } else if (this._isLink(path + "/" + e)) {
        // Classify symlinks without a stat: a stat would follow the
        // link, and for /http/ or /github targets that means fetching
        // the target just to colorize a name.
        kind = "link";
      } else {
        try {
          const st = await this.stat(path + "/" + e);
          if (st && st.type === "dir") kind = "dir";
          else if (st && st.type === "file" && isExecutableName(e)) kind = "exe";
          else if (!st) kind = "file";
        } catch {
          kind = "file";
        }
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
      const full = path + "/" + entry;
      // Symlinks render as lrwxrwxrwx with a "-> target" suffix — no
      // stat of the target (that could mean fetching a 60 MB video).
      const linkTarget = isDir ? null : this._readlinkTarget(full);
      if (linkTarget !== null) {
        const a = this._attrFor(full);
        rows.push({
          mode: "lrwxrwxrwx",
          owner: a.owner,
          size: linkTarget.length,
          date: "-",
          name: colorize(name, "link") + " -> " + linkTarget,
        });
        continue;
      }
      let st = null;
      try {
        st = await this.stat(full);
      } catch {
        st = null;  // remote/virtual backends without metadata
      }
      const type = isDir ? "dir" : (st && st.type) || "file";
      const size = st && st.size !== undefined ? st.size : (isDir ? 0 : "-");
      const mtime = st && st.mtime;
      const exe = type === "file" && isExecutableName(name);
      const a = this._attrFor(path + "/" + entry);
      rows.push({
        mode: modeToString(type === "dir" ? "dir" : "file", a.mode),
        owner: a.owner,
        size,
        date: formatMtime(mtime),
        name: colorize(name, type === "dir" ? "dir" : exe ? "exe" : "file"),
      });
    }
    const sizeW = Math.max(...rows.map(r => String(r.size).length));
    const dateW = Math.max(...rows.map(r => r.date.length));
    return rows.map(r =>
      `${r.mode} 1 ${r.owner} ${r.owner} ${String(r.size).padStart(sizeW)} ${r.date.padEnd(dateW)} ${r.name}`
    ).join("\n") + "\n";
  }

  // Long listing for a single FILE path (`ls -l /path/to/file`). Real
  // ls prints the file's own entry; formatList can't — listing a file
  // path is ENOTDIR. Rendered with the same columns as formatLongList.
  async formatLongFile(path) {
    const name = path.split("/").filter(Boolean).pop() || "/";
    // A symlink path renders as the link itself (lrwxrwxrwx -> target),
    // like GNU ls -l without a trailing slash.
    const linkTarget = this._readlinkTarget(path);
    if (linkTarget !== null) {
      const a = this._attrFor(path);
      return `lrwxrwxrwx 1 ${a.owner} ${a.owner} ${String(linkTarget.length)} - ${colorize(name, "link")} -> ${linkTarget}\n`;
    }
    const st = await this.stat(path);
    const type = st && st.type === "dir" ? "dir" : "file";
    const size = st && st.size !== undefined ? st.size : "-";
    const a = this._attrFor(path);
    const exe = type === "file" && isExecutableName(name);
    return `${modeToString(type, a.mode)} 1 ${a.owner} ${a.owner} ${String(size).padStart(String(size).length)} ${formatMtime(st && st.mtime)} ${colorize(name, type === "dir" ? "dir" : exe ? "exe" : "file")}\n`;
  }
}

// ─── ls colors ─────────────────────────────────────────────────
// ANSI SGR codes: directories blue, executable files green, plain
// files white (the terminal renders the escapes; browsers map them
// to their palette in www/index.html).
const ANSI = {
  blue: "\x1b[34m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
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
  const code = kind === "dir" ? ANSI.blue
    : kind === "exe" ? ANSI.green
    : kind === "link" ? ANSI.magenta
    : ANSI.white;
  return `${code}${name}${ANSI.reset}`;
}

// Unix-style date column: "Mon DD HH:MM" for this year, else "Mon DD  YYYY"
// rwx string for a mode, no group concept (group bits displayed as other).
function modeToString(type, mode) {
  const seg = (r, w, x) =>
    ((mode & r) ? "r" : "-") + ((mode & w) ? "w" : "-") + ((mode & x) ? "x" : "-");
  const owner = seg(0o400, 0o200, 0o100);
  const other = seg(0o004, 0o002, 0o001);
  // group bits shown as other (no group concept in the VFS)
  return (type === "dir" ? "d" : "-") + owner + other + other;
}

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
