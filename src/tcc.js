// ─── tcc: Tiny C Compiler (wasm32-wasi) command support ─────────
//
// tcc is a real C compiler compiled to wasm32-wasi with a wasm32 code
// target (TinyCC 0.9.28rc + a custom wasm32 backend — see
// build-wasm-tcc.sh). Inside the shell it compiles C straight to wasm:
//
//   tcc -c hello.c -o hello.wasm
//   ./hello.wasm
//
// Two extras make that work in the browser shell:
//
//   1. /usr/bin/tcc.wasm — the compiler binary (from wasm-bin/tcc.wasm,
//      fetched like any other wasm tool).
//
//   2. The libc headers. tcc was built with the include path baked to
//      /tmp/tcc/include (paths inside the WASI sandbox), so on first
//      use we stage the bundled header set (www/wasm-bin/tcc-include.dat,
//      a gzipped [TCC1][headerLen LE][JSON index][data] bundle) into
//      /tmp/tcc/include. /tmp is seeded into the WASI sandbox, so the
//      compiler sees them as /tmp/tcc/include/*.h.
//
// The bundle ships the wasi-libc (musl-style) headers — the compiled
// programs' libc calls (printf/puts/malloc/…) resolve to the shell's
// env runtime (src/c-runtime.js), not to wasi-libc.
// -----------------------------------------------------------------

const HEADER_DIR = "/tmp/tcc/include";
const BUNDLE_URL = "wasm-bin/tcc-include.dat";

import { env } from "./env.js";
import { ensurePako } from "./pako.js";

async function inflate(bytes) {
  if (typeof globalThis.process !== "undefined" && process.versions?.node) {
    const zlib = await import("node:zlib");
    return new Uint8Array(zlib.gunzipSync(bytes));
  }
  if (globalThis.pako) return pako.inflate(bytes);
  await ensurePako();  // lazy-load vendor/pako.min.js in the browser
  if (globalThis.pako) return globalThis.pako.inflate(bytes);
  throw new Error("tcc: no inflate available (pako.min.js not loaded)");
}

// Stage the bundled libc headers into /tmp/tcc/include (idempotent).
// fetchBundle(url) → Uint8Array (CLI: readFileSync; browser: fetch).
export async function ensureTccHeaders(vfs, fetchBundle) {
  const st = await vfs.stat(HEADER_DIR + "/stdio.h").catch(() => null);
  if (st && st.size > 0) return; // already staged

  const raw = await fetchBundle(BUNDLE_URL);
  const bytes = await inflate(raw);
  const magic = new TextDecoder().decode(bytes.slice(0, 4));
  if (magic !== "TCC1") throw new Error("tcc: tcc-include.dat has bad magic");
  const headerLen = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  const index = JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + headerLen)));
  const data = bytes.slice(8 + headerLen);
  for (const [rel, off, len] of index) {
    const blob = new Blob([data.slice(off, off + len)]);
    await vfs.writeBlob(HEADER_DIR + "/" + rel, blob);
  }
}

// Ensure /usr/bin/tcc.wasm is installed; returns its VFS path.
export async function loadTccBinary(vfs, fetchBundle) {
  const tccPath = "/usr/bin/tcc.wasm";
  const st = await vfs.stat(tccPath).catch(() => null);
  if (st && st.size > 0) return tccPath;
  const buf = await fetchBundle("wasm-bin/tcc.wasm");
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  await vfs.writeBlob(tccPath, new Blob([bytes]));
  return tccPath;
}

// The `tcc` command: ensure the binary + headers, then run the compiler
// in the WASI sandbox (cwd = the shell's cwd, so relative paths work).
// The staged headers are read-only input — tell the runner to skip
// harvesting /tmp/tcc back (WASM_SKIP_HARVEST, same as zig's lib dir).
// Returns the WasmRunner (stdout/stderr/exit code available on it).
export async function runTcc({ vfs, runner, args, fetchBundle }) {
  await ensureTccHeaders(vfs, fetchBundle);
  const tccPath = await loadTccBinary(vfs, fetchBundle);
  const prevSkip = env.WASM_SKIP_HARVEST;
  const skips = [HEADER_DIR, ...(prevSkip ? prevSkip.split(":") : [])]
    .filter(Boolean);
  env.WASM_SKIP_HARVEST = skips.join(":");
  try {
    // cc convention: `tcc prog.c` compiles to a.wasm. The wasm32 build
    // has no linker, so without -c tcc would run its link step and write
    // a.out; without -o it writes <src>.o. Normalize both so a bare
    // `tcc sample.c` is a compile that lands in ./a.wasm (like cc).
    let tccArgs = args;
    if (!tccArgs.includes("-c") && !tccArgs.includes("-S"))
      tccArgs = ["-c", ...tccArgs];
    if (!tccArgs.includes("-o")) tccArgs = [...tccArgs, "-o", "a.wasm"];
    return await runner.run(tccPath, ["tcc", ...tccArgs]);
  } finally {
    env.WASM_SKIP_HARVEST = prevSkip || "";
  }
}
