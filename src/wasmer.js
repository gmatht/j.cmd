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
// Repo build scripts: build-wasm-compiler.sh (C→WASM compiler),
// build-wasm-grep.sh (real busybox grep as wasm32-wasi),
// build-wasm-sh2perl.sh (gmatht/sh2perl shell→Perl transpiler).
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
    desc: "Search text with patterns (real busybox grep compiled to wasm32-wasi — see build-wasm-grep.sh)",
  },
  "hexdump": {
    url: "wasm-bin/hexdump.wasm",
    desc: "Hex dump file contents",
  },
  "zstd": {
    url: "wasm-bin/zstd.wasm",
    desc: "Real zstd CLI compiled to wasm32-wasi (facebook/zstd — see build-wasm-zstd.sh). Compress/decompress files and streams: echo hi | zstd | zstd -d",
  },
  "markdown": {
    url: "wasm-bin/markdown.wasm",
    desc: "Markdown → HTML (rsms/markdown-wasm md4c, wasm32-wasi — see build-wasm-markdown.sh). GitHub-style tables/strikethrough/tasklists. Usage: markdown file.md · echo '# hi' | markdown",
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
  "zig": {
    url: "wasm-bin/zig.wasm",
    desc: "Zig compiler (wasm32-wasi, self-hosted codegen — see build-wasm-zig.sh). Usage: zig version · zig build-exe hello.zig -target wasm32-wasi",
  },
  // perl is implemented as a /bin JS command embedding the zeroperl
  // reactor (@6over3/zeroperl-ts) — it is NOT a wasm32-wasi binary, so
  // there is nothing to install here. `perl` works out of the box.
  "make": {
    url: "wasm-bin/make.wasm",
    desc: "Build tool (Makefile runner)",
  },
  "sh2perl": {
    url: "wasm-bin/sh2perl.wasm",
    desc: "Shell→Perl transpiler (gmatht/sh2perl debashc CLI, wasm32-wasip1 — see build-wasm-sh2perl.sh). Usage: sh2perl parse --perl 'echo hi'",
  },
  "cproc": {
    url: "wasm-bin/cproc.wasm",
    desc: "C compiler emitting QBE IR (michaelforney/cproc, wasm32-wasi). The cc command runs cproc → qbe2wasm: cc prog.c && ./a.wasm",
  },
  "compiler": {
    url: "wasm-bin/compiler.wasm",
    desc: "C compiler targeting WebAssembly (c-to-wasm-compiler-project, wasi-sdk build). Usage: compiler prog.c > prog.wat",
  },
  "cc": {
    url: "wasm-bin/compiler.wasm",
    desc: "C compiler (alias for compiler). Usage: cc prog.c",
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

    const destPath = `/usr/bin/${name}.wasm`;

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
