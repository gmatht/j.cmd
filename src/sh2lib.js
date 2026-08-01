// ─── sh2lib: load debashcl.wasm — the unified debashc CLI reactor ─
//
// debashcl.wasm is the full sh2perl CLI compiled as a WASI *reactor*:
// one artifact replaces both debashc.wasm (the _start command) and
// debashl.wasm (the to_perl/to_estree library). It exposes
// debashc_cli_run / _run_json / _run_with_input, so an embedder
// implements debashc in three lines:
//
//   const { instance } = await WebAssembly.instantiate(wasm, { wasi });
//   instance.exports._initialize();
//   const res = instance.exports.debashc_cli_run(argc, argv);
//
// CLI output (ESTree JSON, Perl, lex dumps, help) goes to WASI
// stdout/stderr; the return value is a small JSON envelope. This loader
// hand-rolls the 19 wasi_snapshot_preview1 imports (the filesystem ones
// are stubs — file commands use debashc_cli_run_with_input, so no
// preopens are ever touched) and runs identically in the browser
// (fetch) and Node (readFile).
//
// API (the same contract callers relied on from debashl):
//   toEstree(src) → ESTree JSON object      (argv: file --estree -, input)
//   toPerl(src)   → Perl source             (argv: file --perl -, input)
//   lex(src)      → token dump string       (argv: lex <src>)
//   version()     → version string
// -----------------------------------------------------------------

const WASM_PATH = "wasm-bin/debashcl.wasm";  // browser: relative to the page

let libPromise = null;

export function getSh2Lib() {
  libPromise ??= loadLibrary();
  return libPromise;
}

async function loadWasmBytes() {
  // Browser: fetch from the server. Node (CLI): read from the repo.
  if (typeof fetch !== "undefined") {
    try {
      const resp = await fetch(WASM_PATH);
      if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    } catch { /* fall through to disk */ }
  }
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(
    await readFile(new URL("../www/wasm-bin/debashcl.wasm", import.meta.url))
  );
}

// The 19 WASI imports debashcl needs. Output (fd 1/2) is captured into
// stdout/stderr; the filesystem imports are stubs (ENOSYS) — they are
// never called because file commands use run_with_input.
const ENOSYS = 52, EBADF = 8;

function makeWasiImports(mem, out) {
  const dec = new TextDecoder();
  return {
    wasi_snapshot_preview1: {
      random_get(ptr, len) {
        const bytes = new Uint8Array(mem.memory.buffer, ptr, len);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(bytes);
        } else {
          for (let i = 0; i < len; i++) bytes[i] = (Math.random() * 256) | 0;
        }
        return 0;
      },
      environ_get() { return 0; },
      environ_sizes_get(countPtr, sizePtr) {
        const v = new DataView(mem.memory.buffer);
        v.setUint32(countPtr, 0, true);
        v.setUint32(sizePtr, 0, true);
        return 0;
      },
      clock_time_get(_id, _precision, ptr) {
        new DataView(mem.memory.buffer).setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
      fd_close() { return 0; },
      fd_fdstat_get(fd, buf) {
        const v = new DataView(mem.memory.buffer);
        v.setUint8(buf, 2);  // character device
        v.setUint16(buf + 2, 0, true);
        v.setBigUint64(buf + 8, 0n, true);
        v.setBigUint64(buf + 16, 0n, true);
        return 0;
      },
      fd_filestat_get() { return ENOSYS; },
      fd_prestat_get() { return EBADF; },
      fd_prestat_dir_name() { return EBADF; },
      fd_read() { return ENOSYS; },
      fd_readdir() { return ENOSYS; },
      fd_write(fd, iovs, iovsLen, nwritten) {
        const view = new DataView(mem.memory.buffer);
        const bytes = new Uint8Array(mem.memory.buffer);
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          const s = dec.decode(bytes.subarray(ptr, ptr + len));
          if (fd === 1) out.stdout += s;
          else if (fd === 2) out.stderr += s;
          total += len;
        }
        view.setUint32(nwritten, total, true);
        return 0;
      },
      path_create_directory() { return ENOSYS; },
      path_filestat_get() { return ENOSYS; },
      path_open() { return ENOSYS; },
      path_unlink_file() { return ENOSYS; },
      poll_oneoff() { return 0; },
      proc_exit(code) { throw new Error("debashcl proc_exit(" + code + ")"); },
      sched_yield() { return 0; },
    },
  };
}

async function loadLibrary() {
  const bytes = await loadWasmBytes();
  const mem = { memory: null };
  const out = { stdout: "", stderr: "" };
  // With a Module (compiled bytes), instantiate returns { module, instance }.
  const { instance } = await WebAssembly.instantiate(bytes, makeWasiImports(mem, out));
  mem.memory = instance.exports.memory;
  instance.exports._initialize();  // reactor entry point
  return wrapLibrary(instance, mem, out);
}

function wrapLibrary(instance, mem, out) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ex = instance.exports;

  // Marshal argv (+ optional input bytes) and run the CLI. The CLI's
  // output lands in out.stdout/out.stderr; the return envelope tells us
  // the exit code. Throws on proc_exit (nonzero) — caught by callers.
  function runCli(argv, input) {
    out.stdout = "";
    out.stderr = "";
    const args = ["debashc", ...argv];
    const ptrs = [];
    for (const a of args) {
      const b = enc.encode(a);
      const p = ex.debashc_alloc(b.length);
      new Uint8Array(ex.memory.buffer, p, b.length).set(b);
      ptrs.push(p);
    }
    const table = ex.debashc_alloc(4 * args.length);
    new Uint32Array(ex.memory.buffer, table, args.length).set(ptrs);
    let res;
    try {
      if (input !== undefined) {
        const ib = enc.encode(input);
        const pi = ex.debashc_alloc(ib.length);
        new Uint8Array(ex.memory.buffer, pi, ib.length).set(ib);
        res = ex.debashc_cli_run_with_input(args.length, table, pi, ib.length);
        ex.debashc_free(pi);
      } else {
        res = ex.debashc_cli_run(args.length, table);
      }
    } finally {
      for (const p of ptrs) ex.debashc_free(p);
      ex.debashc_free(table);
    }
    const n = ex.debashc_str_len(res);
    const envelope = JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, res, n)));
    ex.debashc_free(res);
    if (!envelope.ok) throw new Error(`debashcl: ${envelope.error || "failed"}`);
    return { stdout: out.stdout, stderr: out.stderr, exit: envelope.exit ?? 0 };
  }

  // Strip the CLI's "Converting to Perl:\n====…" banner.
  const PERL_BANNER = /^Converting to Perl:\n=+\n([\s\S]*?)\n=+\n?$/;

  return {
    // shell source → ESTree JSON object (argv: file --estree -, input)
    toEstree: (sh) => {
      const r = runCli(["file", "--estree", "-"], String(sh));
      return JSON.parse(r.stdout);
    },
    // shell source → Perl source (argv: file --perl -, input)
    toPerl: (sh) => {
      const r = runCli(["file", "--perl", "-"], String(sh));
      const m = PERL_BANNER.exec(r.stdout);
      return m ? m[1] : r.stdout;
    },
    // shell source → token dump
    lex: (sh) => runCli(["lex", String(sh)]).stdout,
    version: () => "debashc 0.1.0 (debashcl)",
  };
}
