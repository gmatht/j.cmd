// ─── DocsFS: the repo's own docs/ mounted as a filesystem ──────
//
//   cat /docs/security.md · ls /docs · cat /docs/README.md
//
// Lets the shell read its own documentation. Browser: fetched from the
// static server (../docs/ relative to the page, so it works from a
// GitHub Pages subdirectory too). Node CLI: read from disk (../docs/).
// Read-only — OverlayFS wraps it so writes warn like other read-only
// mounts.
// -----------------------------------------------------------------

export class DocsFS {
  constructor() {
    this.files = ["README.md", "debashcl-integration.md", "security.md"];
    this._loader = null;
  }

  _rel(path) {
    return path.replace(/^\/+|\/+$/g, "") || "";
  }

  // README.md lives at the repo root, not in docs/.
  _sourcePath(name) {
    return name === "README.md" ? "../README.md" : "../docs/" + name;
  }
  _diskPath(name) {
    return name === "README.md" ? "../../README.md" : "../../docs/" + name;
  }

  // The file loader: browser fetch / Node readFile (resolved lazily so
  // neither environment needs the other's APIs).
  _source() {
    if (this._loader) return this._loader;
    if (typeof document !== "undefined") {
      this._loader = async (name) => {
        const resp = await fetch(this._sourcePath(name));
        if (!resp.ok) throw new Error("ENOENT: " + name);
        return resp.text();
      };
    } else {
      this._loader = async (name) => {
        const { readFile } = await import("node:fs/promises");
        return readFile(new URL(this._diskPath(name), import.meta.url), "utf8");
      };
    }
    return this._loader;
  }

  async list(path) {
    const rel = this._rel(path);
    if (rel) throw new Error("ENOTDIR: " + path);
    return this.files.slice();
  }

  async read(path) {
    const name = this._rel(path);
    if (!this.files.includes(name)) throw new Error("ENOENT: " + path);
    return await (await this._source())(name);
  }

  async readBlob(path) {
    const text = await this.read(path);
    return new Blob([text], { type: "text/plain" });
  }

  async stat(path) {
    const name = this._rel(path);
    if (!name) return { type: "dir", size: 0, mtime: undefined };
    if (!this.files.includes(name)) throw new Error("ENOENT: " + path);
    return { type: "file", size: 0, mtime: undefined };
  }

  statSync(path) {
    const name = this._rel(path);
    if (!name) return { type: "dir", size: 0, mtime: undefined };
    if (!this.files.includes(name)) throw new Error("ENOENT: " + path);
    return { type: "file", size: 0, mtime: undefined };
  }
}
