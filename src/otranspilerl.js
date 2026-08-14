// ─── otranspilerl: the unified transpiler library (sh2loop's Rust port) ─
//
// otranspilerl.wasm is the REAL unified binary — the debashl core (the
// full bash parser → A1 shIR) statically linked with ALL NINE backend
// renderers (c, go, java, js/estree, perl, python, rust, sh, zig) into
// one wasm reactor. The C-ABI (the same contract as debashl::wasi_api)
// exposes the full in-process pipeline:
//
//   otranspilerl_transpile(src, len, srcLang, len, tgtLang, len) → target
//   otranspilerl_shir(src, len)                        → A1 shIR JSON
//   otranspilerl_render(a1, len, lang, len)            → target from A1
//   otranspilerl_version() → "otranspilerl <version>"
//
// String buffers follow the debashl contract: inputs are written into
// memory from otranspilerl_alloc(len) (returns a pointer to the data
// area); every result is a NUL-terminated `[u32 len LE][data][0]` buffer
// whose data pointer the export returns — otranspilerl_str_len reads
// it, otranspilerl_free releases it. Results are JSON envelopes:
//   {"ok":true,"output":"..."}  /  {"ok":false,"error":"..."}
//
// The full pipeline is in-process for shell sources (`sh`, `shir`) —
// every other source language needs the frontend process spawn (not in
// wasm yet) and returns a clear error; feed those frontends' A1 JSON to
// `render` instead. The shell's own `bash`/`bash2js`/`otranspiler`
// paths can drive this library directly.
// -----------------------------------------------------------------

const WASM_PATH = "wasm-bin/otranspilerl.wasm";  // browser: relative to the page
// The sh2runtime device canvas is 800×600 (src/fs/webgldev.js) — the
// shader coordinate space is EMBEDDER-owned: the wasm's glsl/glslv
// take the view width per call, and the frag/vertex programs are
// authored against the same value (the game's shaders write `fx - 400`
// = half of 800). Pass the canvas width explicitly; the default keeps
// old callers (GUI transpile) working.
export const GLSL_VIEW = 800;
// cache-buster — bump whenever www/wasm-bin/otranspilerl.wasm changes so
// the browser (and the otranspiler GUI) never serves a stale wasm.
const WASM_VERSION = "v22-tex32";  // v19: glsl/glslv take the embedder's view size (max_view no longer hardcoded in the wasm) // v17: ES 1.00 mediump precision gate (interval proof over all int intermediates) // v16: texture samples hoisted (2 fetches vs 7) + atom-paren strip // v15: input bridges use-gated (tex/crack/vcolor declared+seeded only when referenced) // v14: glsl DCE + scalar promotion (dead g_pa/g_fit/out_len/OUT_CAP dropped; main() locals) // v13: A1→GLSL render arm (glsl in the TARGETS dispatch — frontend A1s render to shaders) // v12: ForInit + first-class Continue/Break (strip_cfor pass) // v11: template-literal quasi escaping (trailing \ in batch echo)

let libPromise = null;

export function getOtranspilerl() {
  libPromise ??= loadLibrary();
  return libPromise;
}

async function loadWasmBytes() {
  // Browser: fetch from the server. Node (CLI): read from the repo.
  if (typeof fetch !== "undefined") {
    try {
      const resp = await fetch(WASM_PATH + "?v=" + WASM_VERSION);
      if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    } catch { /* fall through to disk */ }
  }
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(
    await readFile(new URL("../www/wasm-bin/otranspilerl.wasm", import.meta.url))
  );
}

// The WASI imports otranspilerl needs (the same shim debashcl uses; the
// filesystem calls are stubs — the library API is in-process, no
// preopens are ever touched). Output (fd 1/2) is captured.
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
      path_filestat_get() { return ENOSYS; },
      path_open() { return ENOSYS; },
      proc_exit(code) { throw new Error("otranspilerl proc_exit(" + code + ")"); },
    },
  };
}

async function loadLibrary() {
  const bytes = await loadWasmBytes();
  const mem = { memory: null };
  const out = { stdout: "", stderr: "" };
  const { instance } = await WebAssembly.instantiate(bytes, makeWasiImports(mem, out));
  mem.memory = instance.exports.memory;
  instance.exports._initialize();  // reactor entry point
  return wrapLibrary(instance, mem, out);
}

function wrapLibrary(instance, mem, out) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ex = instance.exports;

  // Write an input string into wasm memory (otranspilerl_alloc contract).
  function allocInput(s) {
    const b = enc.encode(s);
    const p = ex.otranspilerl_alloc(b.length);
    new Uint8Array(ex.memory.buffer, p, b.length).set(b);
    return { p, len: b.length };
  }

  // Read a result buffer and free it.
  function takeResult(ptr) {
    const n = ex.otranspilerl_str_len(ptr);
    const s = dec.decode(new Uint8Array(ex.memory.buffer, ptr, n));
    ex.otranspilerl_free(ptr);
    return s;
  }

  // Call an export taking N string args (optionally followed by scalar
  // i32 args — the glsl/glslv view size); returns the parsed envelope.
  function call(fn, args, scalars = []) {
    const ins = args.map(allocInput);
    const res = ex[fn](...ins.flatMap((x) => [x.p, x.len]), ...scalars);
    ins.forEach((x) => ex.otranspilerl_free(x.p));
    const env = JSON.parse(takeResult(res));
    if (!env.ok) throw new Error(env.error || "otranspilerl: failed");
    return env;
  }

  return {
    version: () => call("otranspilerl_version", []).output,
    // shell source → target source (in-process: sh and shir only)
    transpile: (src, srcLang, tgtLang) =>
      call("otranspilerl_transpile", [String(src), srcLang || "sh", tgtLang || "js"]).output,
    // shell source → A1 shIR JSON (the neutral contract)
    shir: (src) => call("otranspilerl_shir", [String(src)]).output,
    // A1 shIR JSON → target source (lang: c|go|java|js|perl|python|rs|sh|zig)
    render: (a1, lang) => call("otranspilerl_render", [String(a1), lang]).output,
    // shell → GLSL ES 1.00 render fragment (the MIMEcroft shader pipeline;
    // the `sh2glsl` shell command drives this)
    glsl: (src, view = GLSL_VIEW) => call("otranspilerl_glsl", [String(src)], [view]).output,
    // shell → GLSL ES 1.00 render VERTEX shader (the other MIMEcroft
    // stage; `sh2glsl --vertex` drives this)
    glslv: (src, view = GLSL_VIEW) => call("otranspilerl_glslv", [String(src)], [view]).output,
    raw: call,
  };
}
