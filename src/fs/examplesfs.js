// ─── ExamplesFS: the example corpus mounted as a read-only fs ──
//
//   ls /examples · ls /examples/sh2perl · cat /examples/sh2perl/…
//
// Serves www/examples/ (the sh2perl corpus + any other example files)
// like DocsFS serves docs/: fetched from the static server in the
// browser (relative to the page, so it works from a GitHub Pages
// subdirectory too), read from disk in the node CLI. Read-only —
// OverlayFS wraps it so writes warn like other read-only mounts.
// -----------------------------------------------------------------

export class ExamplesFS {
  constructor() {
    this._loader = null;
    this._corpus = null;
  }

  _rel(path) {
    return path.replace(/^\/+|\/+$/g, "") || "";
  }

  // The file loader: browser fetch / Node readFile (resolved lazily so
  // neither environment needs the other's APIs).
  _source() {
    if (this._loader) return this._loader;
    if (typeof document !== "undefined") {
      this._loader = async (name) => {
        const resp = await fetch("examples/" + name);
        if (!resp.ok) throw new Error("ENOENT: " + name);
        return resp.text();
      };
    } else {
      this._loader = async (name) => {
        const { readFile } = await import("node:fs/promises");
        return readFile(new URL("../../www/examples/" + name, import.meta.url), "utf8");
      };
    }
    return this._loader;
  }

  // The corpus manifest (sh2perl/index.json) lists every script name.
  async _corpusNames() {
    if (this._corpus) return this._corpus;
    try {
      this._corpus = JSON.parse(await (await this._source())("sh2perl/index.json"));
    } catch {
      this._corpus = [];
    }
    return this._corpus;
  }

  async list(path) {
    const rel = this._rel(path);
    if (!rel) return ["sh2perl"];
    if (rel === "sh2perl") return await this._corpusNames();
    throw new Error("ENOTDIR: " + path);
  }

  async read(path) {
    const rel = this._rel(path);
    if (!rel) throw new Error("EISDIR: " + path);
    return await (await this._source())(rel);
  }
}
