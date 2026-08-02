#!/bin/bash
# ─── build-wasm-nethack.sh ──────────────────────────────────────
# Fetch the REAL NetHack 3.6.7 compiled to WASM — the prebuilt
# @neth4ck/wasm-367 npm package (emscripten build of the actual C
# game; win/shim window system + Asyncify). The game data (/nhdat,
# /sysconf) is embedded in the wasm.
#
# Installs:
#   www/vendor/nethack.js   — emscripten glue (ESM factory)
#   www/vendor/nethack.wasm — the game, ~4.9MB
#
# Usage:  ./build-wasm-nethack.sh
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching @neth4ck/wasm-367 from npm…"
echo "  (source: our fork gmatht/neth4ck-monorepo — NetHack licence, see docs/licences.md)"
cd "$WORK"
npm pack @neth4ck/wasm-367 >/dev/null
tar xzf neth4ck-wasm-367-*.tgz
cp package/build/nethack.js package/build/nethack.wasm "$REPO/www/vendor/"
echo ""
echo "✓ Installed:"
echo "  www/vendor/nethack.js   ($(du -h "$REPO/www/vendor/nethack.js" | cut -f1))"
echo "  www/vendor/nethack.wasm ($(du -h "$REPO/www/vendor/nethack.wasm" | cut -f1))"
echo "  In the shell:  nethack    (browser) · nethack --demo (CLI autoplay)"
