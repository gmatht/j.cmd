// ─── LocalStorageFS: Persistent filesystem backed by localStorage ─
//
// Survives page reloads. Data lives in the browser's localStorage.
// Size limit: ~5-10MB (per origin). Great for /home/, config files.
//
// localStorage keys are prefixed with "fs:" to avoid collisions with
// other data the application might store.
// -----------------------------------------------------------------

const KEY_PREFIX = "fs:";
// Marker prefix for base64-encoded binary content stored in localStorage
const B64_MARKER = "\u0001b64:";

// Encode bytes to base64 (browser-safe, no atob/btoa chunk issues)
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class LocalStorageFS {
  constructor() {
    // We maintain a directory index in localStorage for fast listing.
    // The index is a JSON array of directory paths.
    this._initIndex();
  }

  _initIndex() {
    if (localStorage.getItem(KEY_PREFIX + ".dirs") === null) {
      localStorage.setItem(KEY_PREFIX + ".dirs", JSON.stringify(["/"]));
    }
  }

  _dirs() {
    return JSON.parse(localStorage.getItem(KEY_PREFIX + ".dirs") || "[]");
  }

  _saveDirs(dirs) {
    localStorage.setItem(KEY_PREFIX + ".dirs", JSON.stringify([...new Set(dirs)].sort()));
  }

  _addDir(dir) {
    const dirs = this._dirs();
    if (!dirs.includes(dir)) {
      dirs.push(dir);
      this._saveDirs(dirs);
    }
  }

  _parent(path) {
    const p = path.replace(/\/+$/, "");
    // Root or empty → root
    if (p === "" || p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i === 0 ? "/" : p.slice(0, i);
  }

  _ensureParent(path) {
    const parent = this._parent(path);
    // Stop at root — it's always in the dirs index
    if (parent === "/") return;
    const dirs = this._dirs();
    if (!dirs.includes(parent)) {
      this._ensureParent(parent);
      dirs.push(parent);
      this._saveDirs(dirs);
    }
  }

  async read(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();
    if (dirs.includes(norm)) throw new Error("EISDIR: Is a directory");

    const key = KEY_PREFIX + "file:" + norm;
    const data = localStorage.getItem(key);
    if (data === null) throw new Error("ENOENT");
    // Decode binary content back to original form
    if (data.startsWith(B64_MARKER)) {
      return new TextDecoder().decode(base64ToBytes(data.slice(B64_MARKER.length)));
    }
    return data;
  }

  async readBlob(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();
    if (dirs.includes(norm)) throw new Error("EISDIR");

    const key = KEY_PREFIX + "file:" + norm;
    const data = localStorage.getItem(key);
    if (data === null) throw new Error("ENOENT");
    if (data.startsWith(B64_MARKER)) {
      return new Blob([base64ToBytes(data.slice(B64_MARKER.length))]);
    }
    return new Blob([data], { type: "text/plain" });
  }

  async write(path, content) {
    const norm = path.replace(/\/$/, "") || "/";
    this._ensureParent(norm);
    localStorage.setItem(KEY_PREFIX + "file:" + norm, content);
  }

  async writeBlob(path, blob) {
    const norm = path.replace(/\/$/, "") || "/";
    this._ensureParent(norm);
    // Store binary as base64 with a marker so readBlob can recover bytes
    const buffer = await blob.arrayBuffer();
    localStorage.setItem(
      KEY_PREFIX + "file:" + norm,
      B64_MARKER + bytesToBase64(new Uint8Array(buffer))
    );
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();
    if (!dirs.includes(norm)) throw new Error("ENOTDIR");

    const prefix = norm === "/" ? "/" : norm + "/";
    const entries = new Set();

    // List files in localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX + "file:")) {
        const filePath = key.slice((KEY_PREFIX + "file:").length);
        if (filePath.startsWith(prefix) && filePath !== prefix) {
          const rest = filePath.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) entries.add(name);
        }
      }
    }

    // List subdirectories
    for (const dir of dirs) {
      if (dir.startsWith(prefix) && dir !== norm) {
        const rest = dir.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name + "/");
      }
    }

    return [...entries].sort();
  }

  async remove(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const dirs = this._dirs();

    if (dirs.includes(norm)) {
      // Remove all children
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(KEY_PREFIX + "file:" + norm + "/")) {
          localStorage.removeItem(key);
        }
      }
      // Remove subdirectory entries
      this._saveDirs(dirs.filter(d => !d.startsWith(norm + "/") && d !== norm));
    } else {
      localStorage.removeItem(KEY_PREFIX + "file:" + norm);
    }
  }
}
