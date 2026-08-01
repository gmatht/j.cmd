// ─── DownloadFS: /pc/ — bridge between virtual FS and real machine ─
//
// Write to /pc/<name> → triggers a browser download of that file
// to the user's Downloads folder (filename already known, so just
// download like normal).
// Read from /pc/ → opens a file picker to select a local file.
//
// Examples:
//   cp report.csv /pc            → downloads report.csv
//   echo hello > /pc/note.txt    → downloads note.txt
//   cp /pc/photo.jpg .           → file picker → import into virtual FS
// -----------------------------------------------------------------

// Extension → MIME type hints for the open-file picker
const MIME_HINTS = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".txt": "text/plain", ".md": "text/markdown", ".log": "text/plain",
  ".json": "application/json", ".js": "text/javascript",
  ".wasm": "application/wasm", ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".zip": "application/zip",
  ".sh": "text/x-sh", ".rs": "text/x-rust", ".c": "text/x-c",
  ".html": "text/html", ".css": "text/css", ".py": "text/x-python",
};

function mimeHint(path) {
  const lower = path.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_HINTS)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

export class DownloadFS {
  async read(path) {
    const file = await this._pickFile(path);
    return await file.text();
  }

  async readBlob(path) {
    // Return the File directly — File extends Blob and preserves bytes
    return await this._pickFile(path);
  }

  async _pickFile(path) {
    const name = path.replace(/^\//, "");
    const mime = mimeHint(name);

    // Prefer the File System Access API (Chromium)
    if (window.showOpenFilePicker) {
      const options = {};
      if (mime) {
        options.types = [{ description: name, accept: { [mime]: [name.split(".").pop()] } }];
        options.excludeAcceptAllOption = true;
      }
      try {
        const [handle] = await window.showOpenFilePicker(options);
        return await handle.getFile();
      } catch (e) {
        throw new Error(`file picker cancelled: ${e.message}`);
      }
    }

    // Fallback (Firefox/Safari): hidden <input type=file>
    return await this._pickViaInput(mime);
  }

  _pickViaInput(mime) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      if (mime) input.accept = mime;
      input.style.display = "none";
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files && input.files[0];
        document.body.removeChild(input);
        if (file) resolve(file);
        else reject(new Error("no file selected"));
      };
      // User pressed Escape / cancelled
      input.addEventListener("cancel", () => {
        document.body.removeChild(input);
        reject(new Error("file picker cancelled"));
      });
      input.click();
    });
  }

  async write(path, content) {
    const name = path.replace(/^\//, "");
    if (!name) {
      throw new Error("EROFS: specify a filename (/pc/name)");
    }
    const blob = typeof content === "string"
      ? new Blob([content], { type: mimeHint(name) || "text/plain" })
      : new Blob([content]);
    this._download(name, blob);
  }

  async writeBlob(path, blob) {
    const name = path.replace(/^\//, "");
    if (!name) {
      throw new Error("EROFS: specify a filename (/pc/name)");
    }
    this._download(name, blob);
  }

  // ─── writeStream: STREAM a download instead of materializing it ───
  // With StreamSaver (vendored: streamsaver.js + mitm.html + sw.js) the
  // data is piped through a service worker to a real incremental disk
  // write, so huge artifacts (tar -czf /pc/backup.tgz /) never sit in
  // memory. Without a service worker (or in the CLI) it falls back to
  // buffering the chunks and downloading one Blob at close.
  // Returns a WHATWG WritableStream; write Uint8Array chunks, close()
  // finishes the download.
  async writeStream(path, { size } = {}) {
    const name = path.replace(/^\//, "");
    if (!name) throw new Error("EROFS: specify a filename (/pc/name)");
    const mime = mimeHint(name) || "application/octet-stream";

    if (typeof window !== "undefined" && typeof document !== "undefined") {
      try {
        await this._ensureStreamSaver();
        const opts = {};
        if (size) opts.size = size;
        return window.streamSaver.createWriteStream(name, opts);
      } catch {
        // StreamSaver unavailable (SW blocked / offline) — buffer instead
      }
    }

    // Buffered fallback: collect chunks, download one Blob on close.
    const chunks = [];
    const enc = new TextEncoder();
    const download = () => this._download(name, new Blob(chunks, { type: mime }));
    return new WritableStream({
      write(chunk) {
        chunks.push(chunk instanceof Uint8Array ? chunk : enc.encode(String(chunk)));
      },
      close() { download(); chunks.length = 0; },
      abort() { chunks.length = 0; },
    });
  }

  // Load the vendored StreamSaver lib and point it at our mitm page.
  async _ensureStreamSaver() {
    if (window.streamSaver && window.streamSaver.createWriteStream) {
      window.streamSaver.mitm = "vendor/mitm.html";
      return;
    }
    await new Promise((resolve, reject) => {
      const src = "vendor/streamsaver.js";
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => { window.streamSaver.mitm = "vendor/mitm.html"; resolve(); };
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  _download(name, blob) {
    // Filename is already known — just download like a normal browser
    // download to the Downloads folder. No save dialog needed.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async list(path) {
    return [];
  }

  async stat(path) {
    // Never fall back to read() — read() opens the file picker! /pc is
    // a virtual bridge to the real machine: the mount root is a dir,
    // and any /pc/<name> only exists once you pick a file for it.
    const p = path.replace(/^\/+|\/+$/g, "") || "/";
    if (p === "/") return { type: "dir", size: 0, mtime: undefined };
    return { type: "file", size: 0, mtime: undefined };
  }

  async remove(path) {
    throw new Error("EROFS: cannot remove from /pc/");
  }
}
