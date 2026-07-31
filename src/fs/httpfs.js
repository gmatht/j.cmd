// ─── HttpFS: Fetch remote URLs as files ─────────────────────────
// Only works for CORS-enabled origins:
//   api.github.com, registry.npmjs.org, pypi.org, raw.githubusercontent.com
//   pokeapi.co, api.chess.com, api.weather.gov, cdn.jsdelivr.net

import { RamFS } from "./ramfs.js";

export class HttpFS {
  constructor() {
    this.cache = new RamFS();
  }

  _url(path) {
    let url = path.replace(/^\//, "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    return url;
  }

  async read(path) {
    try {
      return await this.cache.read(path);
    } catch {}

    const url = this._url(path);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const text = await resp.text();
    await this.cache.write(path, text);
    return text;
  }

  async readBlob(path) {
    const url = this._url(path);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const blob = await resp.blob();
    // Also cache text version for read()
    try {
      const text = await blob.text();
      await this.cache.write(path, text);
    } catch {}
    return blob;
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
