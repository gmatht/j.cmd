// ─── HttpFS: Fetch remote URLs as files ─────────────────────────
// Only works for CORS-enabled origins:
//   api.github.com, registry.npmjs.org, pypi.org, raw.githubusercontent.com
//   pokeapi.co, api.chess.com, api.weather.gov, cdn.jsdelivr.net
//
// `ls /http/` lists a curated set of sample files (audio, images,
// video, text) from CORS-enabled archives — each verified to send
// `Access-Control-Allow-Origin: *`:
//   archive.org (mp3 only — small files land on the CORS-enabled
//     ia*.us.archive.org nodes; large video streams go to the
//     dn*.ca.archive.org nodes, which DON'T send CORS),
//   raw.githubusercontent.com, cdn.jsdelivr.net,
//   upload.wikimedia.org, mdn.github.io (GitHub Pages), picsum.photos

import { RamFS } from "./ramfs.js";

// Featured sample files, one per common mime type. The path form is
// the URL itself, so `cat /http/<path>` fetches https://<path> with no
// rewriting — copy-paste straight from the listing. Verified CORS:
// each of these serves Access-Control-Allow-Origin: * and (for the
// archives) supports Range requests.
const FEATURED = [
  { path: "archive.org/download/testmp3testfile/mpthreetest.mp3",
    desc: "mp3 — Internet Archive test file" },
  { path: "raw.githubusercontent.com/mdn/webaudio-examples/main/audio-analyser/viper.mp3",
    desc: "mp3 — MDN WebAudio example (GitHub raw)" },
  { path: "upload.wikimedia.org/wikipedia/commons/d/db/Alligatorbellowedit.ogg",
    desc: "ogg — Wikimedia Commons alligator bellow" },
  { path: "upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png",
    desc: "png — Wikimedia Commons image" },
  { path: "picsum.photos/id/237/200/300",
    desc: "jpg — picsum.photos placeholder" },
  { path: "upload.wikimedia.org/wikipedia/commons/3/3b/Big_Buck_Bunny_extract.ogv",
    desc: "ogv — Big Buck Bunny extract (Theora: plays in Firefox, not Chromium)" },
  { path: "upload.wikimedia.org/wikipedia/commons/c/c1/Diehl_Wecker_%28ca._1955%29.webm",
    desc: "webm — 1955 clock film, VP9 1080p (Wikimedia Commons, 12 MB)" },
  { path: "mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4",
    desc: "mp4 — MDN learning area (GitHub Pages)" },
  { path: "raw.githubusercontent.com/git/git/master/README.md",
    desc: "txt — git repo README (GitHub raw)" },
];

const README_PATH = "README.md";

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
    const rel = path.replace(/^\/+/, "");
    if (rel === README_PATH) return this._readme();

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
    // well-known path patterns: the root shows a curated set of sample
    // files from CORS-enabled archives. Any deeper path is the open
    // URL space and lists nothing (cat/curl still reach it).
    const rel = (path || "/").replace(/^\/+/, "");
    if (rel !== "") return [];
    return [...FEATURED.map(f => f.path), README_PATH];
  }

  // Curated entries are known files; everything else is unknown without
  // fetching. Returning null keeps `ls` from ever downloading a sample
  // file just to size it (some are 60 MB+).
  async stat(path) {
    const rel = path.replace(/^\/+/, "");
    if (rel === README_PATH) return { type: "file", size: 0, mtime: undefined };
    for (const f of FEATURED) {
      if (f.path === rel) return { type: "file", size: 0, mtime: undefined };
    }
    return null;
  }

  async write(path, content) {
    // Writing to HTTP would require PUT/POST — not implemented
    throw new Error("EROFS: Read-only filesystem (HTTP)");
  }

  async remove(path) {
    await this.cache.remove(path);
  }

  _readme() {
    let text = `HTTP Filesystem
===============

Mount point for fetching any CORS-enabled URL as a file — the path IS
the URL:

  cat /http/example.com/data.json
  curl /http/raw.githubusercontent.com/git/git/master/README.md

The browser enforces CORS, so only origins that send
Access-Control-Allow-Origin respond. This mount is read-only; writes
land in a local overlay instead.

Featured sample files (CORS verified — one per file type):
`;
    for (const f of FEATURED) {
      text += `  ${f.path}\n      ${f.desc}\n`;
    }
    text += `\nAny other CORS-enabled URL is fair game: ls lists only the
curated set, but cat/curl reach the whole web.\n`;
    return text;
  }
}
