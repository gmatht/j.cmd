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
// Repo build scripts: build-wasm-grep.sh (real busybox grep as wasm32-wasi),
// build-wasm-cproc.sh / build-wasm-tcc.sh (the cc/tcc C compilers).
// debashcl.wasm (bash toolchain) is vendored — see vendor/sh2/.
//
// Usage in jtsh:
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
  "cproc": {
    url: "wasm-bin/cproc.wasm",
    desc: "C compiler emitting QBE IR (michaelforney/cproc, wasm32-wasi). The cc command runs cproc → qbe2wasm: cc prog.c && ./a.wasm",
  },
  "tcc": {
    url: "wasm-bin/tcc.wasm",
    desc: "Tiny C Compiler (TinyCC 0.9.28rc with a wasm32 backend, wasm32-wasi — see build-wasm-tcc.sh). Compiles C to wasm: tcc -c hello.c -o hello.wasm && ./hello.wasm",
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

    // zig also needs its lib (std + compiler_rt — the exact sources the
    // wasm compiler was built from; a newer 0.16.0 snap's std uses
    // builtins the wasm build predates).  Stage it from the gzipped
    // bundle into /tmp/zig-lib (RamFS — the WASI /tmp seed picks it up)
    // and point the compiler at it.  The lib is read-only; WASM_SKIP_HARVEST
    // keeps the runner from harvesting it back on every run.
    if (name === "zig") {
      const lb = await fetch("wasm-bin/zig-lib.dat");
      if (lb.ok) {
        let bytes = new Uint8Array(await lb.arrayBuffer());
        if (typeof process !== "undefined" && process.versions && process.versions.node) {
          const zlib = await import("node:zlib");
          bytes = new Uint8Array(zlib.gunzipSync(bytes));
        } else {
          const { ensurePako } = await import("./pako.js");
          if (globalThis.pako) bytes = new Uint8Array(globalThis.pako.inflate(bytes));
          else { await ensurePako(); bytes = new Uint8Array(globalThis.pako.inflate(bytes)); }
        }
        const magic = new TextDecoder().decode(bytes.slice(0, 4));
        if (magic === "ZIG1") {
          const headerLen = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
          const index = JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + headerLen)));
          const data = bytes.slice(8 + headerLen);
          for (const [rel, off, len] of index) {
            await this.vfs.writeBlob("/tmp/zig-lib" + rel, new Blob([data.slice(off, off + len)]));
          }
          const { env } = await import("./env.js");
          env.ZIG_LIB_DIR = "/tmp/zig-lib";
          env.ZIG_LOCAL_CACHE_DIR = "/tmp/.zig-cache-local";
          env.ZIG_GLOBAL_CACHE_DIR = "/tmp/.zig-cache";
          env.WASM_SKIP_HARVEST = ((env.WASM_SKIP_HARVEST || "").split(":").filter(Boolean))
            .concat(["/tmp/zig-lib", "/tmp/.zig-cache-local", "/tmp/.zig-cache"])
            .join(":");
          return { name, path: destPath, size: blob.size, lib: index.length + " files staged" };
        }
      }
    }

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
