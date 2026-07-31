// ─── wasmer install: Download WASM packages into /bin/ ──────────
//
// Registry of known WASM binaries compiled to wasm32-wasi.
// Each entry has a name, URL, and description.
// URLs should point to .wasm files (preferably from reputable sources).
//
// Usage in tinysh:
//   wasmer install echo            → download echo.wasm to /bin/
//   wasmer search grep             → search registry
//   wasmer list                    → list available packages
// -----------------------------------------------------------------

const REGISTRY = {
  "echo": {
    url: "echo.wasm",  // local demo file
    desc: "Echo text back (demo)",
    source: "sh2runtime demo"
  },
  "grep": {
    url: "https://github.com/iddm/wasm-grep/releases/download/v0.1.0/wasm-grep.wasm",
    desc: "Search text with patterns",
    source: "github.com/iddm/wasm-grep"
  },
  "curl": {
    url: "https://github.com/wasmerio/wasmer/releases/download/4.3.0/wasmer-curl.wasm",
    desc: "Fetch URLs (HTTP client)",
    source: "wasmer.io"
  },
  "hexdump": {
    url: "https://github.com/wasmerio/wasmer/releases/download/4.3.0/wasmer-hexdump.wasm",
    desc: "Hex dump file contents",
    source: "wasmer.io"
  },
};

export class WasmerRegistry {
  constructor(vfs) {
    this.vfs = vfs;
  }

  async install(name) {
    const pkg = REGISTRY[name];
    if (!pkg) {
      throw new Error(`Package '${name}' not found. Try 'wasmer list' or 'wasmer search <term>'.`);
    }

    const url = pkg.url;

    // For local demo files, resolve relative to the HTML page
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);

    const blob = await resp.blob();
    const destPath = `/bin/${name}.wasm`;
    await this.vfs.writeBlob(destPath, blob);

    return { name, path: destPath, size: blob.size };
  }

  search(term) {
    const results = [];
    const lower = term.toLowerCase();
    for (const [name, pkg] of Object.entries(REGISTRY)) {
      if (name.includes(lower) || pkg.desc.toLowerCase().includes(lower)) {
        results.push({ name, ...pkg });
      }
    }
    return results;
  }

  list() {
    return Object.entries(REGISTRY).map(([name, pkg]) => ({
      name,
      desc: pkg.desc,
      source: pkg.source,
      installed: false,  // would need to check /bin/
    }));
  }
}
