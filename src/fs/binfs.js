// ─── BinFS: the bundled command templates as a real directory ───
//
//   ls /bin · cat /bin/cowsay.js · MIMEcroft.sh
//
// Serves www/bin/ (the shell's bundled .js/.sh command templates) like
// ExamplesFS serves www/examples/: fetched from the static server in
// the browser, read from disk in the node CLI. /bin is therefore a
// TRADITIONAL directory — every template is listed and readable from
// boot, no lazy materialization step — with the fetched bytes held in
// an in-memory cache. `rm -r /cache/bin` drops that cache (and the
// local overlay, see the VFS wiring) so the next read picks up newly
// deployed template versions.
//
// Listing sources, in order:
//   1. a live directory index from the server (serve.py provides one;
//      parsed like the tab-completer always has), or readdirSync in node
//   2. the committed www/bin/index.json manifest — GitHub Pages serves
//      no directory indexes, so deployments fall back to it
//   3. nothing (an empty listing) — reads BY NAME still work, and the
//      shells' autoLoad probes a template by name as a last resort
//
// Read-only — OverlayFS wraps it so writes/tombstones land in the
// local overlay like every other template-backed mount.
//
// NB: no STATIC node imports — the browser links these modules
// directly, so every node: API is imported lazily inside the CLI
// branches (the ExamplesFS pattern).
// -----------------------------------------------------------------

async function nodeReaddir(dir) {
  const { readdirSync } = await import("node:fs");
  return readdirSync(new URL("../../www/bin/" + dir, import.meta.url), { withFileTypes: true });
}

// bumped whenever the template FORMAT changes — the query string makes
// even a stubborn HTTP cache revalidate (`cache: "no-cache"` does the
// conditional GET; this guarantees a changed URL on top)
const BIN_CACHE_VERSION = "1";

export class BinFS {
  constructor() {
    this._listing = null;   // [{ name, dir }] | null (not fetched yet)
    this._files = new Map(); // rel path → text (session content cache)
  }

  _rel(path) {
    return String(path).replace(/^\/+|\/+$/g, "");
  }

  // Drop every cached byte/listing — the next access re-fetches (the
  // `/cache` purge calls this so `rm -r /cache/bin` refreshes /bin).
  clearCache() {
    this._listing = null;
    this._files.clear();
  }

  // The file loader: browser fetch / node readFile. Resolved lazily so
  // neither environment needs the other's APIs. The bgworker's blob
  // module worker has no page base for a relative fetch — the main
  // thread injects the absolute base (__SH2_BIN_BASE) before the first
  // read (mirrors __SH2_EXAMPLES_BASE).
  _load(rel) {
    if (typeof document !== "undefined") {
      const g = typeof globalThis !== "undefined" ? globalThis : null;
      const base = (g && g.__SH2_BIN_BASE) ? String(g.__SH2_BIN_BASE) : "bin/";
      return fetch(base + rel + "?v=" + BIN_CACHE_VERSION, { cache: "no-cache" })
        .then(async (resp) => {
          if (!resp.ok) throw new Error("ENOENT: " + rel);
          return resp.text();
        });
    }
    return import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../www/bin/" + rel, import.meta.url), "utf8"));
  }

  async read(path) {
    const rel = this._rel(path);
    if (!rel) throw new Error("EISDIR");
    if (this._files.has(rel)) return this._files.get(rel);
    const text = await this._load(rel);
    this._files.set(rel, text);
    return text;
  }

  // ── listing ─────────────────────────────────────────────────────
  // Live directory index (browser: the server's autoindex HTML; node:
  // readdirSync), falling back to the committed index.json manifest.
  async _entries() {
    if (this._listing) return this._listing;
    this._listing = await this._liveEntries().catch(() => this._manifestEntries());
    return this._listing;
  }

  async _liveEntries() {
    if (typeof document !== "undefined") {
      const g = typeof globalThis !== "undefined" ? globalThis : null;
      const base = (g && g.__SH2_BIN_BASE) ? String(g.__SH2_BIN_BASE) : "bin/";
      const resp = await fetch(base);
      if (!resp.ok) throw new Error("no directory index");
      const html = await resp.text();
      const out = [];
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const name = decodeURIComponent(m[1]);
        if (!name || name.startsWith("..") || name.includes("://") || name.startsWith("/")) continue;
        out.push({ name: name.replace(/\/$/, ""), dir: name.endsWith("/") });
      }
      if (out.length === 0) throw new Error("no directory index");
      return out;
    }
    return (await nodeReaddir(""))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }

  async _manifestEntries() {
    try {
      const manifest = await this._load("index.json");
      return JSON.parse(manifest).map((name) => ({ name: name.replace(/\/$/, ""), dir: name.endsWith("/") }));
    } catch {
      return [];
    }
  }

  async list(path) {
    const rel = this._rel(path);
    const entries = await this._entries();
    if (!rel) return entries.map((e) => e.name + (e.dir ? "/" : "")).sort();
    // one level inside a template-subdirectory (busybox/, go-sh/, …)
    const hit = entries.find((e) => e.name === rel);
    if (hit && hit.dir) return await this._subEntries(rel);
    throw new Error(`ENOTDIR: ${path}`);
  }

  async _subEntries(dir) {
    if (typeof document !== "undefined") {
      const g = typeof globalThis !== "undefined" ? globalThis : null;
      const base = (g && g.__SH2_BIN_BASE) ? String(g.__SH2_BIN_BASE) : "bin/";
      const resp = await fetch(base + dir + "/");
      if (!resp.ok) return [];
      const html = await resp.text();
      const out = [];
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const name = decodeURIComponent(m[1]);
        if (!name || name.startsWith("..") || name.includes("://") || name.startsWith("/")) continue;
        out.push(name.replace(/\/$/, "") + (name.endsWith("/") ? "/" : ""));
      }
      return out.sort();
    }
    return (await nodeReaddir(dir + "/"))
      .map((e) => e.name + (e.isDirectory() ? "/" : "")).sort();
  }

  async stat(path) {
    const rel = this._rel(path);
    if (!rel) return { type: "dir", size: 0, mtime: 0 };
    const entries = await this._entries();
    const hit = entries.find((e) => e.name === rel.split("/")[0]);
    if (hit && hit.dir) {
      if (rel.split("/").length === 1) return { type: "dir", size: 0, mtime: 0 };
      // a file inside a template subdirectory — loadable?
      try { await this.read(rel); return { type: "file", size: 0, mtime: 0 }; }
      catch { throw new Error("ENOENT: " + path); }
    }
    try { await this.read(rel); return { type: "file", size: 0, mtime: 0 }; }
    catch { throw new Error("ENOENT: " + path); }
  }

  // Synchronous stat — the runtime's SYNC ls (sourced C function bodies)
  // uses it. Without an async listing we can't know for sure; consult a
  // listing fetched earlier when one exists, else assume a file (the
  // ExamplesFS precedent — top-level names are overwhelmingly files).
  statSync(path) {
    const rel = this._rel(path);
    if (!rel) return { type: "dir", size: 0 };
    if (this._listing) {
      const hit = this._listing.find((e) => e.name === rel.split("/")[0]);
      if (hit && hit.dir && rel.split("/").length === 1) return { type: "dir", size: 0 };
      if (hit) return { type: "file", size: 0 };
    }
    return { type: "file", size: 0 };
  }

  // Cache metadata for a listing, if the wrapped backend caches (used by
  // the shells to print "cached X ago" next to remote listings).
  cacheInfo() { return null; }
}

// Re-exported for the version query the deploy docs mention — keeps a
// single source of truth for the cache-busting marker.
export { BIN_CACHE_VERSION };
