#!/usr/bin/env node
// ─── download-wasm-bins.js ─────────────────────────────────────
// Download pre-compiled WASM binaries from known sources and cache
// them locally in www/wasm-bin/ so the browser shell can install
// them instantly without depending on external services.
//
// To add a new WASM binary:
//   1. Compile with:  cargo build --target wasm32-wasip1 --release
//   2. Copy to:       www/wasm-bin/<name>.wasm
//   3. Add entry in   src/wasmer.js REGISTRY
//
// Usage:  node download-wasm-bins.js
// -----------------------------------------------------------------

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, "www", "wasm-bin");

async function main() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  // Copy the demo echo.wasm if it exists at the old location
  const demoWasm = path.join(__dirname, "www", "demo.wasm");
  const echoDest = path.join(BIN_DIR, "echo.wasm");
  if (fs.existsSync(demoWasm) && !fs.existsSync(echoDest)) {
    fs.copyFileSync(demoWasm, echoDest);
    console.log("  ✓ echo.wasm — copied from demo.wasm");
  }

  const files = fs.readdirSync(BIN_DIR).filter(f => f.endsWith(".wasm"));
  console.log(`\n${files.length} WASM binaries in ${BIN_DIR}:`);
  for (const f of files.sort()) {
    const size = fs.statSync(path.join(BIN_DIR, f)).size;
    console.log(`  ${f}  ${(size / 1024).toFixed(0)}K`);
  }

  console.log(`\nTo add more binaries:
  1. Compile: cargo build --target wasm32-wasip1 --release
  2. Copy:    cp target/wasm32-wasip1/release/<name>.wasm www/wasm-bin/
  3. Update:  src/wasmer.js REGISTRY entry`);
}

main().catch(console.error);
