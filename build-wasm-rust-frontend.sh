#!/bin/bash
# ─── build-wasm-rust-frontend.sh ─────────────────────────────────
# Build the fleet's rust-frontend (syn-based Rust source → A1 shIR) to
# wasm32-wasip1 for the web GUI.
#
# www/wasm-bin/rust-frontend.wasm is the REAL frontend binary — pure
# Rust (syn + serde_json, no cgo), so it compiles to wasm32-wasip1 like
# otranspilerl. www/otranspiler.html runs it through the shared WASI
# runner (src/wasm.js) with the source staged into the VFS.
#
# Usage:
#   ./build-wasm-rust-frontend.sh
#   RUST_FRONTEND=/path/to/rust-frontend ./build-wasm-rust-frontend.sh
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SRC="${RUST_FRONTEND:-/home/llm/sh2loop/frontends/rust-frontend}"

if [ ! -f "$SRC/Cargo.toml" ]; then
  echo "error: rust-frontend source not found at $SRC (set RUST_FRONTEND=…)" >&2
  exit 1
fi

echo "== rust-frontend source: $SRC =="
if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-wasip1$'; then
  echo "  adding wasm32-wasip1 target…"
  rustup target add wasm32-wasip1
fi

echo "== cargo build --release --target wasm32-wasip1 =="
( cd "$SRC" && cargo build --release --target wasm32-wasip1 )

WASM="$SRC/target/wasm32-wasip1/release/rust-frontend.wasm"
if [ ! -f "$WASM" ]; then
  echo "error: build did not produce $WASM" >&2
  exit 1
fi

cp "$WASM" "$REPO/www/wasm-bin/rust-frontend.wasm"

echo ""
echo "== verify through src/rustfrontend.js =="
cd "$REPO"
node --input-type=module - <<'EOF'
import { fs } from "./src/fs/index.js";
import { rustfrontendA1 } from "./src/rustfrontend.js";
const a1 = await rustfrontendA1('fn main() { let x = 5; println!("{}", x); }', fs);
console.log("  rust A1 stmts:", a1.stmts.length, "->", JSON.stringify(a1.stmts[0]?.expr?.func ?? a1.stmts[0]?.type));
EOF

echo ""
echo "✓ Installed:"
echo "  www/wasm-bin/rust-frontend.wasm  ($(du -h "$REPO/www/wasm-bin/rust-frontend.wasm" | cut -f1))"
