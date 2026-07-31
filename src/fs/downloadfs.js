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
    const name = path.replace(/^\//, "");
    const picker = window.showOpenFilePicker;
    if (!picker) {
      throw new Error("File picker not supported in this browser");
    }

    // If the path hints at a type (e.g. /pc/photo.png), pass it as a filter
    const mime = mimeHint(name);
    const options = {};
    if (mime) {
      options.types = [{ description: name, accept: { [mime]: [name.split(".").pop()] } }];
      options.excludeAcceptAllOption = true;
    }

    try {
      const [handle] = await picker(options);
      const file = await handle.getFile();
      return await file.text();
    } catch (e) {
      throw new Error(`file picker cancelled: ${e.message}`);
    }
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

  async remove(path) {
    throw new Error("EROFS: cannot remove from /pc/");
  }
}
