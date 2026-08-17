// ─── rustfrontend: the fleet's rust-frontend as a browser wasm ─────
//
// rust-frontend (sh2loop frontends/rust-frontend) is a pure-Rust CLI —
// syn + serde_json, no cgo — so it compiles to wasm32-wasip1 like
// otranspilerl. It reads `--shir <file.rs>` and writes the A1 shIR JSON
// contract to stdout (the same shape every frontend emits). This module
// stages the wasm + source into the VFS and runs it through the shared
// WASI runner (src/wasm.js WasmRunner — @wasmer/wasi + wasmfs bridge),
// the same path tcc/bash/etc. use, and returns the parsed A1.
//
// The busybox merge is Go-only; rust-frontend is a Rust binary, so it
// ships as its own wasm module (www/wasm-bin/rust-frontend.wasm, built
// by build-wasm-rust-frontend.sh).
// -----------------------------------------------------------------

const WASM_PATH = "wasm-bin/rust-frontend.wasm";
// cache-buster — bump whenever the wasm changes so the browser never
// serves a stale staged copy.
const WASM_VERSION = "v1-rf";

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
    await readFile(new URL("../www/wasm-bin/rust-frontend.wasm", import.meta.url))
  );
}

export async function rustfrontendA1(source, fs, onLog) {
  const log = onLog || (() => {});
  const { WasmRunner } = await import("./wasm.js");
  const wasmRunner = new WasmRunner(fs);
  const wasmVfs = "/tmp/rustfrontend/rust-frontend.wasm";
  const srcVfs = "/tmp/rustfrontend/input.rs";
  try { await fs.write("/tmp/rustfrontend/.directory", ""); } catch {}
  await fs.write(srcVfs, String(source));
  const bytes = await loadWasmBytes();
  await fs.writeBlob(wasmVfs, new Blob([bytes]));
  log("parsing rust source → A1 shIR (rust-frontend wasm)…");
  await wasmRunner.run(wasmVfs, ["rust-frontend", "--shir", srcVfs, "--raw"]);
  const out = String(wasmRunner.getStdout() || "").trim();
  const rerr = String(wasmRunner.getStderr() || "").trim();
  if (wasmRunner.getExitCode() !== 0) {
    throw new Error("rust frontend: " + (out || rerr || ("exit " + wasmRunner.getExitCode())).slice(0, 300));
  }
  const start = out.indexOf("{");
  if (start < 0) throw new Error("rust frontend: no A1 contract in output: " + out.slice(0, 120));
  return JSON.parse(out.slice(start));
}
