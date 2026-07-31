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
//   /http/        → HttpFS        (CORS fetch access)
//   /proc/        → ProcFS        (process info + browser stats)
//   /dev/         → DevFS         (browser devices)
//   /pc/          → DownloadFS    (downloads)
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
    // /bin — the shell's binaries. JavaScript is the binary format, so
    // user/system .js commands live here (persistent). /commands is kept
    // as an alias mount so old paths and existing files keep working.
    const commands = hasLocalStorage ? new LocalStorageFS() : new RamFS();
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
      "# export PATH=/bin:/usr/bin\n" +
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
    syncWrite(this._getBackend("/bin/sayhello.js"), "/sayhello.js", helloContent);
    syncWrite(this._getBackend("/bin/counter.js"), "/counter.js", counterContent);
    // mail — compose email via mailto: in a new tab. Written when
    // absent or outdated (marker in the header), so user edits survive
    // reloads while version updates still reach existing installs.
    const mailContent = `// mail v2 — compose email via mailto: in a new tab (browser) or printed URL (CLI).
// v2: the first-use provider picker is a dropdown, not a text prompt.
//
//   mail to@example.com
//   mail to@example.com -s "Subject" -b "Body"
//   mail a@x.com b@y.com -s "Hi" -b "..."        multiple recipients
//   mail --provider proton to@example.com        one-shot provider
//   mail --set gmail                             change default provider
//   mail                                         show provider + usage
//
// First use shows a dropdown asking which provider should open the
// compose window (gmail / outlook / proton / fastmail / yahoo / default)
// and stores the choice in ~/.config/mail.provider.
//
// NOTE: no backslashes, backticks or dollar-brace sequences in this
// file — the shell embeds it verbatim in a template literal at boot,
// so any escape sequence would be mangled.

var NL = String.fromCharCode(10);
var CONFIG = ((env.HOME || "/home").replace(RegExp("/+$"), "") || "/") + "/.config/mail.provider";
var isBrowser = typeof window !== "undefined";

// Compose-window URL builders. "default" opens the bare mailto: URL and
// lets the OS/browser mail handler deal with it.
var PROVIDERS = {
  gmail:    function (m) { return "https://mail.google.com/mail/?extsrc=mailto&url=" + encodeURIComponent(m); },
  outlook:  function (m) { return "https://outlook.live.com/mail/0/deeplink/compose?" + mailQuery(m); },
  proton:   function (m) { return "https://mail.proton.me/u/0/compose?" + mailQuery(m); },
  fastmail: function (m) { return "https://app.fastmail.com/compose/?" + mailQuery(m); },
  yahoo:    function (m) { return "https://compose.mail.yahoo.com/?" + mailQuery(m); },
  default:  function (m) { return m; },
};
var KNOWN = Object.keys(PROVIDERS);

// mailto:to?subject=..&body=.. → to/subject/body params for webmail
// compose endpoints (they don't understand mailto: themselves).
function mailQuery(mailto) {
  var sep = mailto.indexOf("?");
  var to = sep === -1 ? mailto.slice(7) : mailto.slice(7, sep);
  var params = new URLSearchParams(sep === -1 ? "" : mailto.slice(sep + 1));
  var q = new URLSearchParams();
  if (to) q.set("to", to);
  if (params.get("subject")) q.set("subject", params.get("subject"));
  if (params.get("body")) q.set("body", params.get("body"));
  return q.toString();
}

async function readProvider() {
  try {
    var raw = await fs.read(CONFIG);
    return raw.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

function normalize(name) {
  var p = String(name || "").trim().toLowerCase();
  return KNOWN.includes(p) ? p : null;
}

function usage() {
  console.log("mail — compose email via mailto: in a new tab");
  console.log("  mail to@example.com");
  console.log('  mail to@example.com -s "Subject" -b "Body"');
  console.log('  mail a@x.com b@y.com -s "Hi" -b "..."   multiple recipients');
  console.log("  mail --provider proton to@example.com   one-shot provider");
  console.log("  mail --set gmail                        change default provider");
  console.log("  mail                                    show provider + usage");
  console.log("Providers: " + KNOWN.join(", "));
  console.log("Config: " + CONFIG);
}

// Dropdown provider picker (browser only) — a small modal with a <select>,
// because six known providers don't deserve a free-text prompt.
function pickProvider() {
  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100;";
    var box = document.createElement("div");
    box.style.cssText = "background:#161b22;color:#e0e0e0;border:1px solid #30363d;border-radius:8px;padding:18px 22px;font-family:monospace;min-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.5);";
    var title = document.createElement("div");
    title.textContent = "Default mail provider";
    title.style.cssText = "font-weight:bold;margin-bottom:6px;";
    var sub = document.createElement("div");
    sub.textContent = "Where should mail compose open?" + NL + "Stored in " + CONFIG + NL + "Change anytime with: mail --set <provider>";
    sub.style.cssText = "color:#8b949e;font-size:12px;margin-bottom:12px;line-height:1.5;";
    var select = document.createElement("select");
    select.className = "mail-provider-select";
    select.style.cssText = "width:100%;padding:7px;margin-bottom:12px;background:#0d1117;color:#e0e0e0;border:1px solid #30363d;border-radius:4px;";
    KNOWN.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      select.appendChild(opt);
    });
    select.value = "gmail";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    var ok = document.createElement("button");
    ok.textContent = "Set provider";
    ok.style.cssText = "background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:7px 16px;cursor:pointer;";
    var cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:7px 14px;cursor:pointer;";
    row.appendChild(ok);
    row.appendChild(cancel);
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(select);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close(val) {
      overlay.remove();
      var hi = document.getElementById("hidden-input");
      if (hi) hi.focus();  // hand the keyboard back to the shell
      resolve(val);
    }
    ok.onclick = function () { close(select.value); };
    cancel.onclick = function () { close(null); };
    overlay.onclick = function (e) { if (e.target === overlay) close(null); };
    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); close(select.value); }
      else if (e.key === "Escape") { e.preventDefault(); close(null); }
    });
    select.focus();
  });
}

// Fallback if the DOM modal ever fails — plain prompt.
function fallbackPrompt() {
  return window.prompt(
    "Default mail provider?" + NL + "  " + KNOWN.join(" / ") + NL + "(stored in " + CONFIG + ")",
    "gmail"
  );
}

// ─── parse args ───
var to = [];
var subject = "";
var body = "";
var providerOverride = null;
var setProvider = null;
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "-s") subject = args[++i] || "";
  else if (a === "-b") body = args[++i] || "";
  else if (a === "--set") setProvider = args[++i] || "";
  else if (a === "--provider") providerOverride = args[++i] || "";
  else if (a === "-h" || a === "--help" || a === "help") { usage(); return 0; }
  else to.push(a);
}

// ─── --set: persist a provider and stop ───
if (setProvider) {
  var p = normalize(setProvider);
  if (!p) {
    console.log("mail: unknown provider '" + setProvider + "' — try one of: " + KNOWN.join(", "));
    return 1;
  }
  await fs.write(CONFIG, p + NL);
  console.log("mail: default provider set to " + p + " (stored in " + CONFIG + ")");
  return 0;
}

// bare mail (no recipients/subject/body) — show state, don't compose
if (to.length === 0 && !subject && !body) {
  var cur = await readProvider();
  if (cur) console.log("mail: default provider is " + cur + " (stored in " + CONFIG + ")");
  else console.log("mail: no default provider set — you'll be asked on first compose.");
  usage();
  return 0;
}

// ─── resolve provider (--provider wins; else config; else first-use picker) ───
var provider = providerOverride ? normalize(providerOverride) : await readProvider();

if (providerOverride && !provider) {
  console.log("mail: unknown provider '" + providerOverride + "' — try one of: " + KNOWN.join(", "));
  return 1;
}

if (!provider) {
  if (isBrowser) {
    var answer = null;
    try {
      answer = await pickProvider();
    } catch {
      answer = fallbackPrompt();
    }
    if (answer === null) {
      console.log("mail: cancelled — no provider set. Run: mail --set gmail");
      return 1;
    }
    provider = normalize(answer) || "default";
    await fs.write(CONFIG, provider + NL);
    console.log("mail: default provider is " + provider + " (stored in " + CONFIG + ")");
  } else {
    console.log("mail: no default provider set. Run: mail --set gmail   (or outlook/proton/fastmail/yahoo/default)");
    return 1;
  }
}

// ─── build the mailto: and the compose URL ───
var mailto = "mailto:" + to.join(",");
var params = new URLSearchParams();
if (subject) params.set("subject", subject);
if (body) params.set("body", body);
var qs = params.toString();
if (qs) mailto += "?" + qs;

var url = PROVIDERS[provider](mailto);
var who = to.join(", ") || "(no recipients)";

if (isBrowser) {
  var win = window.open(url, "_blank");
  if (win) {
    console.log("mail: opening " + provider + " compose window for " + who);
  } else {
    console.log("mail: popup blocked — open this URL manually:");
    console.log(url);
  }
} else {
  console.log("mail: " + who + " via " + provider);
  console.log(url);
  console.log("(open the URL in a browser to compose)");
}
return 0;
`;
    this._getBackend("/bin/mail.js").read("/mail.js")
      .then((existing) => {
        if (!existing.includes("mail v2")) {
          syncWrite(this._getBackend("/bin/mail.js"), "/mail.js", mailContent);
        }
      })
      .catch(() => syncWrite(this._getBackend("/bin/mail.js"), "/mail.js", mailContent));

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
    syncWrite(this._getBackend("/bin/webgldemo.js"), "/webgldemo.js", webglDemoContent);

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
    syncWrite(this._getBackend("/bin/audiodemo.js"), "/audiodemo.js", audioDemoContent);


    // arecord — record the microphone (arecord-compatible options).
    // Browser only (getUserMedia + Web Audio); writes WAV/raw/AU to the
    // virtual filesystem. Version-gated (v1 marker) so updates reach
    // existing installs.
    const arecordContent = `// arecord v1 — record microphone audio (arecord-compatible options)
//
// NAME
//      arecord — record microphone audio
//
// SYNOPSIS
//      arecord [options] [file]
//
// DESCRIPTION
//      Records the browser microphone to the virtual filesystem as a
//      WAV file, with options mirroring the ALSA arecord command:
//      duration, format, rate, channels, file type and device. The
//      browser microphone is a mono source; -c 2 duplicates it into
//      both channels, and recordings are resampled to -r.
//
//      With no [file], records to $HOME/pcm.wav. Use a /pc/ path to
//      download the result (e.g. /pc/rec.wav). A file of "-" prints a
//      base64 data URL (this shell's stdout is text, so raw binary
//      cannot be written to it).
//
// OPTIONS
//      -d, --duration=SECONDS  record for SECONDS (default 10)
//      -f, --format=FORMAT     sample format: S16_LE (default), U8,
//                              S8, S24_LE, S32_LE, FLOAT_LE and their
//                              _BE twins; cd and dat are presets
//      -r, --rate=HZ           sample rate (default 8000, like arecord)
//      -c, --channels=N        channels: 1 (default) or 2 (stereo mix)
//      -t, --file-type=TYPE    wav (default), raw or au
//      -D, --device=NAME       microphone: default or a deviceId from
//                              arecord -l
//      -l, --list-devices      list capture hardware
//      -L, --list-pcms         list PCM names
//      -q, --quiet             suppress status lines
//      -v, --verbose           extra diagnostics
//      -h, --help              show this help
//
// EXAMPLES
//      arecord -d 5 out.wav
//      arecord -f cd -d 3 song.wav
//      arecord -r 16000 -c 1 -f S16_LE -d 2 clip.wav
//      arecord -d 2 -t raw clip.pcm
//      arecord -l
//
// NOTE: recording cannot be interrupted mid-flight — Ctrl+C returns
// to the prompt but the recording finishes its -d seconds in the
// background and still writes the file.

var isBrowser = typeof navigator !== "undefined" &&
  navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";

var FORMATS = {
  U8:       { bits: 8,  tag: 1, signed: false, le: true,  label: "Unsigned 8 bit" },
  S8:       { bits: 8,  tag: 1, signed: true,  le: true,  label: "Signed 8 bit" },
  S16_LE:   { bits: 16, tag: 1, signed: true,  le: true,  label: "Signed 16 bit Little Endian" },
  S16_BE:   { bits: 16, tag: 1, signed: true,  le: false, label: "Signed 16 bit Big Endian" },
  S24_LE:   { bits: 24, tag: 1, signed: true,  le: true,  label: "Signed 24 bit Little Endian" },
  S24_BE:   { bits: 24, tag: 1, signed: true,  le: false, label: "Signed 24 bit Big Endian" },
  S32_LE:   { bits: 32, tag: 1, signed: true,  le: true,  label: "Signed 32 bit Little Endian" },
  S32_BE:   { bits: 32, tag: 1, signed: true,  le: false, label: "Signed 32 bit Big Endian" },
  FLOAT_LE: { bits: 32, tag: 3, signed: true,  le: true,  label: "Float 32 bit Little Endian" },
  FLOAT_BE: { bits: 32, tag: 3, signed: true,  le: false, label: "Float 32 bit Big Endian" },
};

function usage() {
  console.log("arecord — record microphone audio (arecord-compatible options)");
  console.log("usage: arecord [options] [file]");
  console.log("");
  console.log("  -d, --duration=SECONDS  record for SECONDS (default 10)");
  console.log("  -f, --format=FORMAT     S16_LE (default), U8, S8, S24_LE, S32_LE,");
  console.log("                          FLOAT_LE (and _BE twins), or cd / dat presets");
  console.log("  -r, --rate=HZ           sample rate (default 8000, like arecord)");
  console.log("  -c, --channels=N        1 (default) or 2 (stereo mix of the mono mic)");
  console.log("  -t, --file-type=TYPE    wav (default), raw, au");
  console.log("  -D, --device=NAME       microphone: default or a deviceId from -l");
  console.log("  -l, --list-devices      list capture devices");
  console.log("  -L, --list-pcms         list PCM names");
  console.log("  -q, --quiet             no status lines");
  console.log("  -v, --verbose           extra diagnostics");
  console.log("  -h, --help              this help");
  console.log("");
  console.log("file defaults to $HOME/pcm.wav; '-' prints a base64 data URL");
  console.log("(this shell's stdout is text — raw binary can't go through it)");
}

function sleep(ms) {
  return new Promise(function (res) { setTimeout(res, ms); });
}

function writeAscii(v, off, s) {
  for (var k = 0; k < s.length; k++) v.setUint8(off + k, s.charCodeAt(k));
}

function writeSample(v, off, s, fmt) {
  s = Math.max(-1, Math.min(1, s));
  if (fmt.tag === 3) { v.setFloat32(off, s, fmt.le); return; }
  if (fmt.bits === 8) {
    var b8 = fmt.signed ? Math.round(s * 127) : Math.round((s + 1) * 127.5);
    v.setUint8(off, b8 & 0xff);
  } else if (fmt.bits === 16) {
    v.setInt16(off, Math.round(s * 32767), fmt.le);
  } else if (fmt.bits === 24) {
    var b24 = Math.round(s * 8388607);
    if (fmt.le) {
      v.setUint8(off, b24 & 0xff);
      v.setUint8(off + 1, (b24 >> 8) & 0xff);
      v.setUint8(off + 2, (b24 >> 16) & 0xff);
    } else {
      v.setUint8(off, (b24 >> 16) & 0xff);
      v.setUint8(off + 1, (b24 >> 8) & 0xff);
      v.setUint8(off + 2, b24 & 0xff);
    }
  } else {
    v.setInt32(off, Math.round(s * 2147483647), fmt.le);
  }
}

function buildWav(samples, rate, ch, fmt) {
  var bytesPer = fmt.bits / 8;
  var block = ch * bytesPer;
  var dataSize = samples.length * bytesPer;
  var buf = new ArrayBuffer(44 + dataSize);
  var v = new DataView(buf);
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, fmt.tag, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, fmt.bits, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataSize, true);
  for (var j = 0; j < samples.length; j++) writeSample(v, 44 + j * bytesPer, samples[j], fmt);
  return new Uint8Array(buf);
}

function buildRaw(samples, fmt) {
  var bytesPer = fmt.bits / 8;
  var buf = new ArrayBuffer(samples.length * bytesPer);
  var v = new DataView(buf);
  for (var j = 0; j < samples.length; j++) writeSample(v, j * bytesPer, samples[j], fmt);
  return new Uint8Array(buf);
}

function buildAu(samples, rate, ch, fmt) {
  var enc;
  if (fmt.bits === 8) enc = 2;
  else if (fmt.bits === 16) enc = 3;
  else if (fmt.bits === 24) enc = 4;
  else if (fmt.tag === 3) enc = 6;
  else enc = 5;
  var bytesPer = fmt.bits / 8;
  var dataSize = samples.length * bytesPer;
  var buf = new ArrayBuffer(24 + dataSize);
  var v = new DataView(buf);
  writeAscii(v, 0, ".snd");
  v.setUint32(4, 24, false);
  v.setUint32(8, dataSize, false);
  v.setUint32(12, enc, false);
  v.setUint32(16, rate, false);
  v.setUint32(20, ch, false);
  var auFmt = { bits: fmt.bits, tag: fmt.tag, signed: true, le: false };
  for (var j = 0; j < samples.length; j++) writeSample(v, 24 + j * bytesPer, samples[j], auFmt);
  return new Uint8Array(buf);
}

function resample(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  var ratio = fromRate / toRate;
  var outLen = Math.round(mono.length / ratio);
  var out = new Array(outLen);
  for (var j = 0; j < outLen; j++) {
    var pos = j * ratio;
    var i0 = Math.min(Math.floor(pos), mono.length - 1);
    var i1 = i0 + 1 < mono.length ? i0 + 1 : i0;
    var frac = pos - i0;
    out[j] = mono[i0] + (mono[i1] - mono[i0]) * frac;
  }
  return out;
}

function expandChannels(mono, ch) {
  if (ch === 1) return mono;
  var out = new Array(mono.length * 2);
  for (var j = 0; j < mono.length; j++) {
    out[j * 2] = mono[j];
    out[j * 2 + 1] = mono[j];
  }
  return out;
}

function toBase64(bytes) {
  var bin = "";
  for (var j = 0; j < bytes.length; j += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
  }
  return btoa(bin);
}

async function listDevices() {
  console.log("**** List of CAPTURE Hardware Devices ****");
  if (!isBrowser) {
    console.log("no capture hardware: not running in a browser with mediaDevices");
    return;
  }
  var devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  var mics = [];
  for (var i = 0; i < devs.length; i++) {
    if (devs[i].kind === "audioinput") mics.push(devs[i]);
  }
  if (!mics.length) {
    console.log("no microphone found (grant mic permission first, then try again)");
    return;
  }
  console.log("device 0: Default Microphone [default]");
  for (var j = 0; j < mics.length; j++) {
    var label = mics[j].label || ("Microphone " + (j + 1));
    console.log("device " + (j + 1) + ": " + label + " [" + mics[j].deviceId + "]");
  }
}

function listPcms() {
  console.log("**** List of PCMs ****");
  console.log("default");
  console.log("sysdefault");
  console.log("front");
  console.log("surround40");
  console.log("surround51");
  console.log("surround71");
  console.log("(this shell records through the browser microphone; -D accepts");
  console.log(" 'default' or a deviceId from: arecord -l)");
}

// ─── parse options (getopt-style: -d5, -r 16000, --duration=5, --) ───
var expanded = [];
for (var ai = 0; ai < args.length; ai++) {
  var arg = args[ai];
  if (arg === "--") {
    for (var ai2 = ai + 1; ai2 < args.length; ai2++) expanded.push(args[ai2]);
    break;
  }
  if (arg.length > 2 && arg.charAt(0) === "-" && arg.charAt(1) !== "-") {
    var rest = arg.slice(1);
    var i2 = 0;
    while (i2 < rest.length) {
      var c = rest.charAt(i2);
      if (c === "d" || c === "c" || c === "r" || c === "f" || c === "t" || c === "D") {
        expanded.push("-" + c);
        if (i2 + 1 < rest.length) expanded.push(rest.slice(i2 + 1));
        break;
      }
      if (c === "h" || c === "l" || c === "L" || c === "q" || c === "v" || c === "M") {
        expanded.push("-" + c);
        i2++;
        continue;
      }
      expanded.push("-" + c + rest.slice(i2 + 1));
      break;
    }
  } else {
    expanded.push(arg);
  }
}

var duration = null;
var channels = 1;
var rate = 8000;
var format = "S16_LE";
var fileType = "wav";
var device = "default";
var quiet = false;
var verbose = false;
var rateGiven = false;
var channelsGiven = false;
var positional = [];
var i = 0;
while (i < expanded.length) {
  var a = expanded[i];
  var opt = a;
  var inline = null;
  var eq = a.indexOf("=");
  if (a.length > 1 && a.charAt(0) === "-" && eq !== -1) {
    opt = a.slice(0, eq);
    inline = a.slice(eq + 1);
  }
  var val;
  if (opt === "-h" || opt === "--help") { usage(); return 0; }
  if (opt === "-l" || opt === "--list-devices") { await listDevices(); return 0; }
  if (opt === "-L" || opt === "--list-pcms") { listPcms(); return 0; }
  if (opt === "-q" || opt === "--quiet") { quiet = true; i++; continue; }
  if (opt === "-v" || opt === "--verbose") { verbose = true; i++; continue; }
  if (opt === "-M" || opt === "--mmap" || opt === "--disable-resample" ||
      opt === "--disable-channels" || opt === "--disable-format" ||
      opt === "--disable-softvol" || opt === "--test-position" ||
      opt === "--test-nowait") {
    if (verbose) console.log("arecord: ignoring option " + opt);
    i++;
    continue;
  }
  if (opt === "--test-coef" || opt === "--max-file-time") {
    if (verbose) console.log("arecord: ignoring option " + opt);
    if (inline === null) i++;   // skip its numeric argument
    i++;
    continue;
  }
  if (opt === "-d" || opt === "--duration") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    duration = parseFloat(val);
    if (!isFinite(duration) || duration <= 0 || duration > 3600) {
      console.log("arecord: invalid duration '" + val + "' (0 < seconds <= 3600)");
      return 1;
    }
    i++;
    continue;
  }
  if (opt === "-c" || opt === "--channels") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    channels = parseInt(val, 10);
    if (channels !== 1 && channels !== 2) {
      console.log("arecord: channels must be 1 or 2 (the browser mic is mono; 2 mixes it to stereo)");
      return 1;
    }
    channelsGiven = true;
    i++;
    continue;
  }
  if (opt === "-r" || opt === "--rate") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    rate = parseInt(val, 10);
    if (!isFinite(rate) || rate < 8000 || rate > 192000) {
      console.log("arecord: invalid rate '" + val + "' (8000..192000 Hz)");
      return 1;
    }
    rateGiven = true;
    i++;
    continue;
  }
  if (opt === "-f" || opt === "--format") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    var fv = String(val).toLowerCase();
    if (fv === "cd") {
      format = "S16_LE";
      if (!rateGiven) { rate = 44100; rateGiven = true; }
      if (!channelsGiven) { channels = 2; channelsGiven = true; }
    } else if (fv === "dat") {
      format = "S16_LE";
      if (!rateGiven) { rate = 48000; rateGiven = true; }
      if (!channelsGiven) { channels = 2; channelsGiven = true; }
    } else {
      var up = String(val).toUpperCase();
      if (!FORMATS[up]) {
        console.log("arecord: unknown format '" + val + "' (S16_LE, U8, S8, S24_LE, S32_LE, FLOAT_LE, cd, dat)");
        return 1;
      }
      format = up;
    }
    i++;
    continue;
  }
  if (opt === "-t" || opt === "--file-type") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    var tv = String(val).toLowerCase();
    if (tv === "voc") {
      console.log("arecord: voc output is not supported here (use wav, raw or au)");
      return 1;
    }
    if (tv !== "wav" && tv !== "raw" && tv !== "au") {
      console.log("arecord: unknown file type '" + val + "' (wav, raw, au)");
      return 1;
    }
    fileType = tv;
    i++;
    continue;
  }
  if (opt === "-D" || opt === "--device") {
    val = inline !== null ? inline : expanded[++i];
    if (val === undefined) { console.log("arecord: option " + opt + " needs an argument"); usage(); return 2; }
    device = val;
    i++;
    continue;
  }
  if (a === "-") { positional.push("-"); i++; continue; }
  if (a.charAt(0) === "-" && a.length > 1) {
    console.log("arecord: unrecognized option '" + a + "'");
    usage();
    return 2;
  }
  positional.push(a);
  i++;
}

if (positional.length > 1) {
  console.log("arecord: too many file arguments: " + positional.join(" "));
  usage();
  return 2;
}
var outArg = positional.length ? positional[0] : null;
var outPath;
if (outArg === "-") {
  outPath = "-";
} else if (outArg) {
  outPath = typeof fs._resolve === "function" ? fs._resolve(outArg) : outArg;
} else {
  outPath = (env.HOME || "/home") + "/pcm.wav";
}

if (duration === null) {
  duration = 10;
  if (!quiet) console.log("arecord: no -d duration given — recording 10 seconds (use -d N)");
}
if (duration > 120 && !quiet) {
  console.log("arecord: note: recordings are buffered in memory; " + duration + "s may be slow");
}

if (!isBrowser) {
  console.log("arecord: microphone capture needs a browser (getUserMedia)");
  console.log("(run this in the browser shell at http://localhost:8080/www/)");
  return 1;
}

var fmt = FORMATS[format];

var containerName = fileType === "wav" ? "WAVE" : fileType === "au" ? "Sun AU" : "raw data";
if (!quiet) {
  console.log("Recording " + containerName + " '" + outPath + "' : " + fmt.label +
    ", Rate " + rate + " Hz, " + (channels === 1 ? "Mono" : "Stereo"));
}

var Ctor = typeof AudioContext !== "undefined" ? AudioContext
  : typeof webkitAudioContext !== "undefined" ? webkitAudioContext : null;
if (!Ctor) {
  console.log("arecord: no Web Audio API in this environment (needs a browser)");
  return 1;
}

var stream = null;
try {
  var constraints = { audio: {} };
  if (device && device !== "default") constraints.audio.deviceId = { exact: device };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
} catch (e) {
  console.log("arecord: cannot open microphone: " + (e && e.message ? e.message : String(e)));
  console.log("(grant microphone permission and use https or localhost)");
  return 1;
}

var ctx = new Ctor();
if (ctx.state === "suspended") {
  try { await ctx.resume(); } catch (e2) {}
}
if (ctx.state === "suspended") {
  for (var t = 0; t < stream.getTracks().length; t++) stream.getTracks()[t].stop();
  console.log("arecord: audio context suspended (autoplay policy) — click the page once, then retry");
  return 1;
}
var srcRate = ctx.sampleRate;
if (verbose) {
  console.log("arecord: context sampleRate " + srcRate + ", state " + ctx.state);
  var tr = stream.getAudioTracks();
  if (tr.length) {
    console.log("arecord: mic: " + (tr[0].label || "(unlabeled)") +
      (device !== "default" ? " (requested " + device + ")" : ""));
  }
}

var source = ctx.createMediaStreamSource(stream);
var node = ctx.createScriptProcessor(4096, 1, 1);
var zero = ctx.createGain();
zero.gain.value = 0;
source.connect(node);
node.connect(zero);
zero.connect(ctx.destination);

var samples = [];
node.onaudioprocess = function (e) {
  var ch = e.inputBuffer.getChannelData(0);
  for (var k = 0; k < ch.length; k++) samples.push(ch[k]);
};

await sleep(Math.round(duration * 1000) + 150);

node.onaudioprocess = null;
try { source.disconnect(); } catch (e5) {}
try { node.disconnect(); } catch (e6) {}
try { zero.disconnect(); } catch (e7) {}
for (var t2 = 0; t2 < stream.getTracks().length; t2++) stream.getTracks()[t2].stop();
try { await ctx.close(); } catch (e8) {}

var mono = resample(samples, srcRate, rate);
var interleaved = expandChannels(mono, channels);
var bytes;
if (fileType === "raw") bytes = buildRaw(interleaved, fmt);
else if (fileType === "au") bytes = buildAu(interleaved, rate, channels, fmt);
else bytes = buildWav(interleaved, rate, channels, fmt);

var mime = fileType === "wav" ? "audio/wav" : fileType === "au" ? "audio/basic" : "application/octet-stream";

if (outPath === "-") {
  console.log("data:" + mime + ";base64," + toBase64(bytes));
  if (!quiet) console.log("arecord: " + bytes.length + " bytes of " + fmt.label + " audio at " + rate + " Hz");
  return 0;
}

var blob = new Blob([bytes], { type: mime });
await fs.writeBlob(outPath, blob);
if (!quiet) {
  var secs = Math.round((samples.length / srcRate) * 10) / 10;
  console.log("arecord: wrote " + bytes.length + " bytes (" + secs + "s, " + fmt.label +
    ", " + rate + " Hz, " + (channels === 1 ? "mono" : "stereo") + ") to " + outPath);
  console.log("play it with: play " + outPath + "   (or cp " + outPath + " /pc/ to download)");
}
return 0;
`;
    this._getBackend("/bin/arecord.js").read("/arecord.js")
      .then((existing) => {
        if (!existing.includes("arecord v1")) {
          syncWrite(this._getBackend("/bin/arecord.js"), "/arecord.js", arecordContent);
        }
      })
      .catch(() => syncWrite(this._getBackend("/bin/arecord.js"), "/arecord.js", arecordContent));

    // sh2js.js — debashl toolchain command (uses the injected sh2lib facade).
    // Version-gated (v2 marker) so file/pipe support reaches existing installs.
    const sh2jsjsContent = `async function sh2src() {
  if (args[0] === "-f" || args[0] === "--file") {
    if (!args[1]) throw new Error("-f needs a file name");
    return await fs.read(args[1]);
  }
  if (args[0] === "<") {
    if (!args[1]) throw new Error("'<' needs a file name");
    return await fs.read(args[1]);
  }
  if (args[0] === "-" || (args.length === 0 && stdin)) return stdin;
  if (args.length === 1 && !args[0].startsWith("-")) {
    try { return await fs.read(args[0]); } catch { return args[0]; }
  }
  return args.join(" ");
}
// sh2js v2 — transpile bash to JavaScript (debashl ESTree path).
//   sh2js 'echo hi'        inline source
//   sh2js script.sh        bash script file
//   sh2js -f script.sh     bash script file (explicit)
//   cat script.sh | sh2js  from a pipe (or: sh2js -)
//   sh2js -e 'echo hi'     ESTree JSON
if (args[0] === "-e") {
  const ast = await sh2lib.toEstree(args.slice(1).join(" "));
  console.log(JSON.stringify(ast, null, 2));
  return 0;
}
if (args.length === 0 && !stdin) {
  console.log("usage: sh2js '<bash source>' | script.sh | -f FILE | pipe");
  return 2;
}
try {
  console.log(await sh2lib.bashToJs(await sh2src()));
} catch (e) {
  console.log("sh2js: " + e.message);
  return 1;
}
return 0;
`;
    this._getBackend("/bin/sh2js.js").read("/sh2js.js")
      .then((existing) => {
        if (!existing.includes(" v2")) {
          syncWrite(this._getBackend("/bin/sh2js.js"), "/sh2js.js", sh2jsjsContent);
        }
      })
      .catch(() => syncWrite(this._getBackend("/bin/sh2js.js"), "/sh2js.js", sh2jsjsContent));

    // sh2perl.js — debashl toolchain command (uses the injected sh2lib facade).
    // Version-gated (v2 marker) so file/pipe support reaches existing installs.
    const sh2perljsContent = `async function sh2src() {
  if (args[0] === "-f" || args[0] === "--file") {
    if (!args[1]) throw new Error("-f needs a file name");
    return await fs.read(args[1]);
  }
  if (args[0] === "<") {
    if (!args[1]) throw new Error("'<' needs a file name");
    return await fs.read(args[1]);
  }
  if (args[0] === "-" || (args.length === 0 && stdin)) return stdin;
  if (args.length === 1 && !args[0].startsWith("-")) {
    try { return await fs.read(args[0]); } catch { return args[0]; }
  }
  return args.join(" ");
}
// sh2perl v2 — transpile bash to Perl via debashl.
//   sh2perl 'echo hi'      inline source
//   sh2perl script.sh      bash script file
//   sh2perl -f script.sh   bash script file (explicit)
//   cat script.sh | sh2perl  from a pipe (or: sh2perl -)
if (args.length === 0 && !stdin) {
  console.log("usage: sh2perl '<bash source>' | script.sh | -f FILE | pipe");
  return 2;
}
try {
  console.log(await sh2lib.toPerl(await sh2src()));
} catch (e) {
  console.log("sh2perl: " + e.message);
  return 1;
}
return 0;
`;
    this._getBackend("/bin/sh2perl.js").read("/sh2perl.js")
      .then((existing) => {
        if (!existing.includes(" v2")) {
          syncWrite(this._getBackend("/bin/sh2perl.js"), "/sh2perl.js", sh2perljsContent);
        }
      })
      .catch(() => syncWrite(this._getBackend("/bin/sh2perl.js"), "/sh2perl.js", sh2perljsContent));

    // debashc.js — debashl toolchain command (uses the injected sh2lib facade).
    // Version-gated (v2 marker) so file/pipe support reaches existing installs.
    const debashcjsContent = `// debashc v2 — the bash compiler CLI (debashl reactor): parse → ESTree or Perl.
//   debashc parse 'echo hi'          ESTree JSON
//   debashc parse --perl 'echo hi'   Perl source
//   debashc file --estree x.sh       ESTree for a script file
//   debashc file --perl x.sh         Perl for a script file
//   debashc x.sh                     ESTree for a script file
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.log("debashc — bash compiler (debashl)");
  console.log("  debashc parse 'echo hi'              ESTree JSON");
  console.log("  debashc parse --perl 'echo hi'       Perl source");
  console.log("  debashc file --estree x.sh           ESTree for a file");
  console.log("  debashc file --perl x.sh             Perl for a file");
  console.log("  debashc x.sh                         ESTree for a file");
  return args.length ? 0 : 2;
}
async function readSource() {
  if (args[0] === "file") {
    const file = args[2];
    if (!file) throw new Error("file mode needs a file name");
    return await fs.read(file);
  }
  if (args[0] === "<") {
    if (!args[1]) throw new Error("'<' needs a file name");
    return await fs.read(args[1]);
  }
  if (args.length === 1 && !args[0].startsWith("-")) {
    try { return await fs.read(args[0]); } catch { return args[0]; }
  }
  return args.slice(1).join(" ");
}
try {
  const src = await readSource();
  if (args[0] === "parse" && args[1] === "--perl") { console.log(await sh2lib.toPerl(src)); return 0; }
  if (args[0] === "file" && args[1] === "--perl") { console.log(await sh2lib.toPerl(src)); return 0; }
  if (args[0] === "parse") { console.log(JSON.stringify(await sh2lib.toEstree(src), null, 2)); return 0; }
  console.log(JSON.stringify(await sh2lib.toEstree(src), null, 2));
} catch (e) {
  console.log("debashc: " + e.message);
  return 1;
}
return 0;
`;
    this._getBackend("/bin/debashc.js").read("/debashc.js")
      .then((existing) => {
        if (!existing.includes(" v2")) {
          syncWrite(this._getBackend("/bin/debashc.js"), "/debashc.js", debashcjsContent);
        }
      })
      .catch(() => syncWrite(this._getBackend("/bin/debashc.js"), "/debashc.js", debashcjsContent));


    // xclip.js — browser toy/utility command (written only when absent).
    const xclipjsContent = `// xclip — clipboard access for the browser shell (like the Linux xclip).
//   echo hi | xclip          copy stdin to the clipboard (default)
//   xclip -i                 copy stdin to the clipboard
//   xclip -o                 print the clipboard to stdout
//   xclip -c                 clear the clipboard
//   xclip -selection clipboard|primary|secondary — accepted; one clipboard
var isBrowser = typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText;
var mode = "in";
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "-o" || a === "--output") mode = "out";
  else if (a === "-i" || a === "--input") mode = "in";
  else if (a === "-c" || a === "--clear") mode = "clear";
  else if (a === "-selection" || a === "-s") i++;   // one clipboard — accept any
  else if (a === "-h" || a === "--help") {
    console.log("xclip — clipboard access (browser shell)");
    console.log("  echo hi | xclip        copy stdin to the clipboard");
    console.log("  xclip -i               copy stdin to the clipboard");
    console.log("  xclip -o               print the clipboard");
    console.log("  xclip -c               clear the clipboard");
    return 0;
  }
}
if (!isBrowser) {
  console.log("xclip: the browser clipboard is unavailable here (run in the web shell)");
  return 1;
}
if (mode === "out") {
  try {
    var text = await navigator.clipboard.readText();
    console.log(text);
  } catch (e) {
    console.log("xclip: clipboard read denied — allow clipboard-read: " + e.message);
    return 1;
  }
  return 0;
}
if (mode === "clear") {
  try {
    await navigator.clipboard.writeText("");
    console.log("xclip: clipboard cleared");
  } catch (e) { console.log("xclip: " + e.message); return 1; }
  return 0;
}
if (!stdin) {
  console.log("xclip: nothing to copy — pipe text in (echo hi | xclip)");
  return 1;
}
try {
  await navigator.clipboard.writeText(stdin);
  console.log("xclip: " + stdin.length + " chars copied to the clipboard");
} catch (e) {
  console.log("xclip: " + e.message);
  return 1;
}
return 0;
`;
    this._getBackend("/bin/xclip.js").read("/xclip.js")
      .catch(() => syncWrite(this._getBackend("/bin/xclip.js"), "/xclip.js", xclipjsContent));

    // xeyes.js — browser toy/utility command. Version-gated so the
    // v2 launch-guard fix reaches installs that got the buggy v1.
    const xeyesjsContent = `// xeyes v2 — the classic X11 eyes that follow the cursor (browser edition).
//   xeyes          show the eyes; close with any key, a click, or Ctrl+C
if (typeof document === "undefined") {
  console.log("xeyes: needs a browser (run in the web shell)");
  return 1;
}
var overlay = document.createElement("div");
overlay.className = "xeyes-overlay";
overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:40;pointer-events:none;";
var eyes = [];
for (var e = 0; e < 2; e++) {
  var eye = document.createElement("div");
  eye.className = "xeyes-eye";
  eye.style.cssText = "position:absolute;top:24px;width:130px;height:86px;background:#fff;border:3px solid #1a1a2e;border-radius:50%;overflow:hidden;";
  eye.style.left = e === 0 ? "calc(50% - 150px)" : "calc(50% + 20px)";
  var pupil = document.createElement("div");
  pupil.className = "xeyes-pupil";
  pupil.style.cssText = "position:absolute;width:46px;height:46px;background:#1a1a2e;border-radius:50%;left:42px;top:20px;";
  eye.appendChild(pupil);
  overlay.appendChild(eye);
  eyes.push({ eye: eye, pupil: pupil });
}
var label = document.createElement("div");
label.textContent = "xeyes — press any key or Ctrl+C to close";
label.style.cssText = "position:absolute;top:130px;left:50%;transform:translateX(-50%);color:#8b949e;font:12px monospace;";
overlay.appendChild(label);
document.body.appendChild(overlay);

var mx = window.innerWidth / 2, my = 100;
function onMove(e) {
  mx = e.clientX;
  my = e.clientY;
  for (var i = 0; i < eyes.length; i++) {
    var ex = eyes[i];
    var r = ex.eye.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var dx = mx - cx;
    var dy = my - cy;
    var dist = Math.max(1, Math.hypot(dx, dy));
    ex.pupil.style.left = (42 + (dx / dist) * 18) + "px";
    ex.pupil.style.top = (20 + (dy / dist) * 18) + "px";
  }
}
document.addEventListener("mousemove", onMove);
onMove({ clientX: mx, clientY: my });

var blinkTimer = setInterval(function () {
  for (var i = 0; i < eyes.length; i++) {
    eyes[i].pupil.style.height = "5px";
    eyes[i].pupil.style.top = "41px";
  }
  setTimeout(function () {
    for (var i = 0; i < eyes.length; i++) {
      eyes[i].pupil.style.height = "46px";
      eyes[i].pupil.style.top = "20px";
    }
  }, 120);
}, 3200);

// v2: ignore any key delivered by the launch gesture itself (Edge can
// report the Enter that started us differently), so the eyes don't
// self-close the instant they appear.
var launchGuard = Date.now() + 400;
var done = false;
function cleanup() {
  if (done) return;
  done = true;
  clearInterval(blinkTimer);
  document.removeEventListener("mousemove", onMove);
  document.removeEventListener("keydown", onKey);
  overlay.remove();
}
var waitResolve = null;
var wait = new Promise(function (r) { waitResolve = r; });
function onKey() {
  if (Date.now() < launchGuard) return;  // launch gesture — don't self-close
  cleanup();
  waitResolve();
}
document.addEventListener("keydown", onKey);
try {
  await wait;
} finally {
  cleanup();   // Ctrl+C (shell interrupt) also tears the eyes down
}
return 0;
`;
    this._getBackend("/bin/xeyes.js").read("/xeyes.js")
      .then((existing) => {
        if (!existing.includes("xeyes v2")) {
          syncWrite(this._getBackend("/bin/xeyes.js"), "/xeyes.js", xeyesjsContent);
        }
      })
      .catch(() => syncWrite(this._getBackend("/bin/xeyes.js"), "/xeyes.js", xeyesjsContent));

    // xterm.js — floating terminal running the shell itself (xterm.js).
    // Written only when absent, so user edits survive reloads.
    const xtermjsContent = `// xterm — a floating terminal (xterm.js) running the shell itself.
//   xterm            open the floating terminal; type exit to close
// Every line you type is run through the shell's own machinery, so the
// floating terminal sees the same builtins, PATH and filesystem.
var NL = String.fromCharCode(10);
var BS = String.fromCharCode(8);
var DEL = String.fromCharCode(127);
var ETX = String.fromCharCode(3);   // Ctrl+C
var FF = String.fromCharCode(12);   // Ctrl+L
var CR = String.fromCharCode(13);   // Enter
if (typeof document === "undefined") {
  console.log("xterm: needs a browser (run in the web shell)");
  return 1;
}
// Load xterm.js + the fit addon from the local server (node_modules).
function loadScript(src) {
  return new Promise(function (resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) return resolve();
    var s = document.createElement("script");
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("failed to load " + src)); };
    document.head.appendChild(s);
  });
}
try {
  await loadScript("/node_modules/xterm/lib/xterm.js");
  await loadScript("/node_modules/@xterm/addon-fit/lib/addon-fit.js");
} catch (e) {
  console.log("xterm: " + e.message);
  return 1;
}
if (!window.Terminal) { console.log("xterm: Terminal not available after load"); return 1; }
var Terminal = window.Terminal;
if (!document.querySelector('link[href="/node_modules/xterm/css/xterm.css"]')) {
  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/node_modules/xterm/css/xterm.css";
  document.head.appendChild(link);
}
// ── floating window ──
var win = document.createElement("div");
win.className = "xterm-window";
win.style.cssText = "position:fixed;top:10%;left:15%;width:70%;height:60%;background:#0d1117;border:1px solid #30363d;border-radius:8px;z-index:60;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.5);";
var bar = document.createElement("div");
bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:#161b22;color:#8b949e;font:12px monospace;border-bottom:1px solid #30363d;border-radius:8px 8px 0 0;";
var title = document.createElement("span");
title.textContent = "xterm — floating shell (type exit to close)";
var closeBtn = document.createElement("button");
closeBtn.textContent = "x";
closeBtn.style.cssText = "background:#21262d;color:#d6a0a0;border:1px solid #30363d;border-radius:4px;cursor:pointer;padding:0 9px;font:bold 14px monospace;";
bar.appendChild(title);
bar.appendChild(closeBtn);
var body = document.createElement("div");
body.style.cssText = "flex:1;padding:8px;overflow:hidden;";
win.appendChild(bar);
win.appendChild(body);
document.body.appendChild(win);
// ── terminal ──
var term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  convertEol: true,
  scrollback: 1000,
  theme: { background: "#0d1117", foreground: "#e0e0e0", cursor: "#7ec8e3", selectionBackground: "#264f78" },
});
var fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open(body);
fit.fit();
var onResize = function () { try { fit.fit(); } catch (e) {} };
window.addEventListener("resize", onResize);
// ── line editing + routing through the shell ──
var line = "";
function prompt() { term.write("tinysh:" + fs.cwd + "$ "); }
function submit() {
  var cmd = line;
  line = "";
  term.write(NL);
  if (cmd.trim() === "exit" || cmd.trim() === "quit") { closeIt(); return; }
  shell.runLine(cmd).then(function (res) {
    var out = (res && res.out ? res.out : "") + (res && res.err ? res.err : "");
    if (out) term.write(out);
    if (!out.endsWith(NL)) term.write(NL);
    prompt();
  }).catch(function (e) {
    term.write("error: " + e.message + NL);
    prompt();
  });
}
function onData(data) {
  for (var i = 0; i < data.length; i++) {
    var ch = data[i];
    if (ch === CR) submit();
    else if (ch === DEL || ch === BS) {
      if (line.length > 0) { line = line.slice(0, -1); term.write(BS + " " + BS); }
    }
    else if (ch === ETX) { line = ""; term.write("^C" + NL); prompt(); }
    else if (ch === FF) { term.clear(); prompt(); }
    else if (ch >= " ") { line += ch; term.write(ch); }
  }
}
term.onData(onData);
// ── close (button, exit command, or shell Ctrl+C) ──
var done = false;
function cleanup() {
  if (done) return;
  done = true;
  window.removeEventListener("resize", onResize);
  try { term.dispose(); } catch (e) {}
  win.remove();
}
var waitResolve = null;
var wait = new Promise(function (r) { waitResolve = r; });
function closeIt() { cleanup(); waitResolve(); }
closeBtn.onclick = closeIt;
term.write("tinysh floating terminal — commands run through the shell" + NL);
prompt();
term.focus();
try {
  await wait;
} finally {
  cleanup();   // shell Ctrl+C also tears the terminal down
}
return 0;
`;
    this._getBackend("/bin/xterm.js").read("/xterm.js")
      .catch(() => syncWrite(this._getBackend("/bin/xterm.js"), "/xterm.js", xtermjsContent));

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

  // Synchronous stat, or null when the backend can't do it synchronously
  // (remote mounts, missing file). sh2.test's file tests rely on this.
  statSync(path) {
    try {
      const r = this._resolve(path);
      const m = this._findBackend(r);
      if (!m || !m.backend.statSync) return null;
      return m.backend.statSync(m.relative);
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
