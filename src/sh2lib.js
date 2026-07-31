// ─── sh2lib: load debashl.wasm — bash → ESTree/Perl reactor ────
//
// debashl.wasm is the debashc compiler built as a WASI *reactor*
// (exports debashc_to_perl / debashc_to_estree / debashc_lex /
// debashc_version + the memory contract debashc_str_len / debashc_free).
// It imports only six wasi_snapshot_preview1 functions, so instead of
// pulling in @wasmer/wasi we hand-roll those imports — one loader that
// runs identically in the browser (fetch) and Node (readFile).
//
// Memory contract: string exports return a pointer into linear memory
// to a [u32 len LE][data][0] buffer; input goes into a monotonically
// growing scratch region (wasm memory only grows, so offsets never
// collide). Results are JSON envelopes {"ok":true,"output":...}.
// -----------------------------------------------------------------

const WASM_PATH = "wasm-bin/debashl.wasm";  // browser: relative to the page
const PAGE = 65536;
let scratchTop = 0x10000;  // monotonic scratch cursor inside wasm memory

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
    await readFile(new URL("../www/wasm-bin/debashl.wasm", import.meta.url))
  );
}

// The six WASI imports debashl needs. Memory access goes through a
// mutable ref so the import closures see the (possibly grown) buffer.
function makeWasiImports(mem) {
  const dec = new TextDecoder();
  const stdout = { out: "" };  // unused by the reactor, but cheap to keep
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
      fd_write(fd, iovs, iovsLen, nwritten) {
        const view = new DataView(mem.memory.buffer);
        const bytes = new Uint8Array(mem.memory.buffer);
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          if (fd === 1 || fd === 2) {
            stdout.out += dec.decode(bytes.subarray(ptr, ptr + len));
          }
          total += len;
        }
        view.setUint32(nwritten, total, true);
        return 0;
      },
      proc_exit(code) { throw new Error("debashl proc_exit(" + code + ")"); },
    },
  };
}

async function loadLibrary() {
  const bytes = await loadWasmBytes();
  const module = await WebAssembly.compile(bytes);
  const mem = { memory: null };
  // With a compiled Module, instantiate returns the instance directly
  // (only the bytes overload returns { module, instance }).
  const instance = await WebAssembly.instantiate(module, makeWasiImports(mem));
  mem.memory = instance.exports.memory;
  instance.exports._initialize();  // reactor entry point (needs random_get)
  return wrapLibrary(instance, mem);
}

function wrapLibrary(instance, mem) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ex = instance.exports;

  function writeScratch(input) {
    const bytes = enc.encode(input);
    const off = scratchTop;
    scratchTop += (bytes.length + 3) & ~3;  // keep 4-byte aligned
    const needed = off + bytes.length;
    if (ex.memory.buffer.byteLength < needed) {
      ex.memory.grow(Math.ceil((needed - ex.memory.buffer.byteLength) / PAGE));
      mem.memory = ex.memory;
    }
    new Uint8Array(ex.memory.buffer, off, bytes.length).set(bytes);
    return { off, len: bytes.length };
  }

  function callStringFn(fnName, input) {
    const { off, len } = writeScratch(input);
    const ptr = ex[fnName](off, len);
    if (!ptr) throw new Error(`${fnName}: wasm returned a null pointer`);
    const outLen = ex.debashc_str_len(ptr);
    const out = dec.decode(new Uint8Array(ex.memory.buffer, ptr, outLen));
    ex.debashc_free(ptr);
    const env = JSON.parse(out);
    if (!env.ok) throw new Error(`${fnName}: ${env.error}`);
    return env.output;
  }

  return {
    // shell source → Perl source (string)
    toPerl: (sh) => callStringFn("debashc_to_perl", sh),
    // shell source → ESTree JSON object (PLAN.md §1.2 contract, sh2.* namespace)
    toEstree: (sh) => JSON.parse(callStringFn("debashc_to_estree", sh)),
    lex: (sh) => callStringFn("debashc_lex", sh),
    version: () => callStringFn("debashc_version", ""),
  };
}
