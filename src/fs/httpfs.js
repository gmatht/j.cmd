// ─── HttpFS: Fetch remote URLs as files ─────────────────────────
// Only works for CORS-enabled origins:
//   api.github.com, registry.npmjs.org, pypi.org, raw.githubusercontent.com
//   pokeapi.co, api.chess.com, api.weather.gov, cdn.jsdelivr.net
//
// The known sample files form a directory TREE, so the mount browses
// like a filesystem: hosts are folders (ls /http/, cd upload.wikimedia.org/),
// and the curated files sit at the leaves. cat/stat on a known folder
// says EISDIR instead of fetching (or failing on) the host's homepage:
//   ls /http/                            README.md, archive.org/, mdn.github.io/, …
//   ls /http/upload.wikimedia.org/       wikipedia/
//   cat /http/upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png
// Any OTHER path is the open URL space — the path IS the URL, fetched
// straight (no listing, no tree): cat /http/example.com/data.json
//
// Each featured file is verified to send Access-Control-Allow-Origin: *:
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
  { path: "upload.wikimedia.org/wikipedia/commons/c/c1/Diehl_Wecker_%28ca._1955%29.webm",
    desc: "webm — 1955 clock film, VP9 1080p (Wikimedia Commons, 12 MB)" },
  { path: "mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4",
    desc: "mp4 — MDN learning area (GitHub Pages)" },
  { path: "raw.githubusercontent.com/git/git/master/README.md",
    desc: "txt — git repo README (GitHub raw)" },
  { path: "raw.githubusercontent.com/Stuk/jszip/main/test/ref/all.zip",
    desc: "zip — small test archive (jszip); cd into it to browse" },
];

const README_PATH = "README.md";

// A featured path is a known file; every prefix of one is a directory
// in the /http tree. cat/stat on a known dir → EISDIR.
function isKnownDir(rel) {
  if (rel === "") return true; // the mount root is a directory
  return FEATURED.some(f => f.path.startsWith(rel + "/"));
}

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

  // Children of `path` in the known-file tree: directories end with "/".
  // The root lists the hosts; unknown paths list nothing (the URL space
  // can't be enumerated — cat/curl still reach them).
  async list(path) {
    const rel = (path || "/").replace(/^\/+/, "").replace(/\/+$/, "");
    const children = new Set();
    if (rel === "") children.add(README_PATH);
    for (const f of FEATURED) {
      if (rel === "") {
        children.add(f.path.split("/")[0] + "/");
      } else if (f.path.startsWith(rel + "/")) {
        const rest = f.path.slice(rel.length + 1);
        children.add(rest.includes("/") ? rest.split("/")[0] + "/" : rest);
      }
    }
    return [...children].sort();
  }

  // Known dirs and known files are typed; anything else is unknown
  // without fetching (keeps `ls` from downloading samples to size them).
  async stat(path) {
    const rel = path.replace(/^\/+/, "").replace(/\/+$/, "");
    if (rel === README_PATH) return { type: "file", size: 0, mtime: undefined };
    if (isKnownDir(rel)) return { type: "dir", size: 0, mtime: undefined };
    for (const f of FEATURED) {
      if (f.path === rel) return { type: "file", size: 0, mtime: undefined };
    }
    return null;
  }

  async read(path) {
    const rel = path.replace(/^\/+/, "");
    if (rel === README_PATH) return this._readme();
    if (isKnownDir(rel)) throw new Error("EISDIR: Is a directory");

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
    const rel = path.replace(/^\/+/, "");
    if (rel === README_PATH) return new Blob([this._readme()], { type: "text/plain" });
    if (isKnownDir(rel)) throw new Error("EISDIR: Is a directory");

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

Mount point for fetching any CORS-enabled URL as a file. The known
sample files form a folder tree — hosts are directories:

  ls /http/
  cd upload.wikimedia.org/
  cat upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png

Featured sample files (CORS verified — one per file type):
`;
    for (const f of FEATURED) {
      text += `  ${f.path}\n      ${f.desc}\n`;
    }
    text += `\nAny other CORS-enabled URL is fair game: the path IS the URL,
so cat/curl reach the whole web (ls lists only the known tree).
The browser enforces CORS — only origins that send
Access-Control-Allow-Origin respond. This mount is read-only; writes
land in a local overlay instead.\n`;
    return text;
  }
}
