#!/bin/bash
# ─── build-wasm-otranspilerl.sh ─────────────────────────────────
# Build the unified transpiler library (otranspilerl) to WASM.
#
# www/wasm-bin/otranspilerl.wasm is the Rust reactor that statically
# links the debashl core (bash → A1 shIR) with ALL NINE backend
# renderers (c, go, java, js/estree, perl, python, rust, sh, zig),
# exposing the C-ABI (otranspilerl_transpile/shir/render) the shell
# drives via src/otranspilerl.js:
#   • the jtsh fallback — bash syntax jtsh doesn't parse becomes JS
#     and runs against the sh2.* runtime
#   • the /bin otranspiler command's renders (A1 → any target)
#
# Source: gmatht/sh2loop/otranspilerl (the crate; its sh2perl submodule
# is the debashl path dependency — the merged *backend renderers live
# in sh2perl/src/*_backend.rs, see otranspilerl/README.md).
#
# Usage:
#   ./build-wasm-otranspilerl.sh
#   OTRANSPILERL=/path/to/otranspilerl ./build-wasm-otranspilerl.sh
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SRC="${OTRANSPILERL:-/home/llm/sh2loop/otranspilerl}"

if [ ! -f "$SRC/Cargo.toml" ]; then
  echo "error: otranspilerl source not found at $SRC (set OTRANSPILERL)" >&2
  exit 1
fi

echo "== otranspilerl source: $SRC =="
if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-wasip1$'; then
  echo "  adding wasm32-wasip1 target…"
  rustup target add wasm32-wasip1
fi

echo "== cargo build --release --target wasm32-wasip1 =="
# PGSO compiler (the rustloop rustc fork with -Z fn-opt-levels, built from a
# source tarball): ~13% faster transpile at +6% size vs the stable O3 build.
# The wasm32-wasip1 std must match the PGSO toolchain's EXACT version string
# (the fork build in /root/src/rustloop/rust1.96.1 with --short=11 + the
# tarball description — see the rustloop notes). Set PGSO_RUSTC to use it.
PGSO_RUSTC="${PGSO_RUSTC:-}"
if [ -n "$PGSO_RUSTC" ] && [ -x "$PGSO_RUSTC" ]; then
  echo "  (PGSO compiler: $PGSO_RUSTC)"
  ( cd "$SRC" && RUSTC="$PGSO_RUSTC" \
    RUSTFLAGS="-Z fn-opt-levels=$(mktemp --suffix=.txt)" \
    cargo build --release --target wasm32-wasip1 )
else
  echo "  (stable rustc — set PGSO_RUSTC for the PGSO compiler)"
  ( cd "$SRC" && cargo build --release --target wasm32-wasip1 )
fi

WASM="$SRC/target/wasm32-wasip1/release/otranspilerl.wasm"
if [ ! -f "$WASM" ]; then
  echo "error: build did not produce $WASM" >&2
  exit 1
fi

cp "$WASM" "$REPO/www/wasm-bin/otranspilerl.wasm"

echo ""
echo "== verify the C-ABI through src/otranspilerl.js =="
cd "$REPO"
node --input-type=module - <<'EOF'
import { getOtranspilerl } from "./src/otranspilerl.js";
const lib = await getOtranspilerl();
console.log("  version:", lib.version());
console.log("  sh -> js:  ", JSON.stringify(lib.transpile("echo hi", "sh", "js").slice(0, 60)));
console.log("  sh -> sh:  ", JSON.stringify(lib.transpile("x=5; echo $x", "sh", "sh").slice(0, 40)));
console.log("  sh -> zig: ", JSON.stringify(lib.transpile("echo hi", "sh", "zig").slice(0, 40)));
EOF

echo ""
echo "✓ Installed:"
echo "  www/wasm-bin/otranspilerl.wasm  ($(du -h "$REPO/www/wasm-bin/otranspilerl.wasm" | cut -f1))"
