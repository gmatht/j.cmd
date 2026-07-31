// ─── wasmer install: Download WASM packages into /bin/ ──────────
//
// Packages come from the local server's www/wasm-bin/ directory,
// served alongside the HTML at /wasm-bin/<name>.wasm.
//
// To add a new package:
//   1. Compile your Rust/C program to wasm32-wasip1
//   2. Copy the .wasm file to www/wasm-bin/<name>.wasm
//   3. Add an entry in REGISTRY below
//
// Usage in tinysh:
//   wasmer list              → list available packages
//   wasmer install echo      → install from /wasm-bin/echo.wasm
//   wasmer search python     → search registry
// -----------------------------------------------------------------

const REGISTRY = {
  "echo": {
    url: "wasm-bin/echo.wasm",
    desc: "Echo text back (demo, compiled from Rust)",
  },
  "echoc": {
    url: "wasm-bin/echoc.wasm",
    desc: "Echo text back (compiled from C via wasi-sdk)",
  },
  "grep": {
    url: "wasm-bin/grep.wasm",
    desc: "Search text with patterns",
  },
  "hexdump": {
    url: "wasm-bin/hexdump.wasm",
    desc: "Hex dump file contents",
  },
  "which": {
    url: "wasm-bin/which.wasm",
    desc: "Show path of a command",
  },
  "curl": {
    url: "wasm-bin/curl.wasm",
    desc: "HTTP client (fetch URLs)",
  },
  "python": {
    url: "wasm-bin/python.wasm",
    desc: "Python interpreter (MicroPython, 363K)",
  },
  "perl": {
    url: "wasm-bin/perl.wasm",
    desc: "Perl interpreter",
  },
  "make": {
    url: "wasm-bin/make.wasm",
    desc: "Build tool (Makefile runner)",
  },
};

export class WasmerRegistry {
  constructor(vfs) {
    this.vfs = vfs;
  }

  async install(name) {
    const pkg = REGISTRY[name];
    if (!pkg) {
      throw new Error(`Package '${name}' not found. Try 'wasmer list' first.`);
    }

    const destPath = `/bin/${name}.wasm`;

    // Try the local server first
    const resp = await fetch(pkg.url);
    if (!resp.ok) {
      throw new Error(`Package '${name}' not available on server (${resp.status}).\n  Compile it: cargo build --target wasm32-wasip1 --release\n  Then copy to www/wasm-bin/${name}.wasm`);
    }

    const blob = await resp.blob();
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
    }));
  }
}
