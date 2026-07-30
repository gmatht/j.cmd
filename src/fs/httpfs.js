// ─── HttpFS: Fetch remote URLs as files ─────────────────────────
// Only works for CORS-enabled origins:
//   api.github.com, registry.npmjs.org, pypi.org, raw.githubusercontent.com
//   pokeapi.co, api.chess.com, api.weather.gov, cdn.jsdelivr.net

import { RamFS } from "./ramfs.js";

export class HttpFS {
  constructor() {
    this.cache = new RamFS();  // Cache previously fetched files
  }

  async read(path) {
    // Try cache first
    try {
      return await this.cache.read(path);
    } catch {
      // Cache miss — fetch
    }

    // Strip leading slash, build URL
    let url = path.replace(/^\//, "");
    // If it doesn't look like a URL, assume it's a path under /http/
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
      const text = await resp.text();
      // Cache it
      await this.cache.write(path, text);
      return text;
    } catch (e) {
      throw new Error(`ENOENT: ${url} (${e.message})`);
    }
  }

  async list(path) {
    // HTTP endpoints don't have directory listings — but we know some
    // well-known path patterns. For now, return empty.
    return [];
  }

  async write(path, content) {
    // Writing to HTTP would require PUT/POST — not implemented
    throw new Error("EROFS: Read-only filesystem (HTTP)");
  }

  async remove(path) {
    await this.cache.remove(path);
  }
}
