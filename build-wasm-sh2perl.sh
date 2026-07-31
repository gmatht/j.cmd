#!/bin/bash
# ─── build-wasm-sh2perl.sh ─────────────────────────────────────
# Build gmatht/sh2perl — the "Debashc" shell→Perl transpiler
# (bash parser + AST + code generators, written in Rust) — into a
# wasm32-wasip1 binary that the browser shell runs as a native
# command.
#
# Pipeline:
#   1. Clone the upstream repo (or reuse an existing clone)
#   2. cargo build --release --target wasm32-wasip1 --bin debashc
#      (rustup target add wasm32-wasip1 if missing)
#   3. Drop the result in www/wasm-bin/sh2perl.wasm
#
# The upstream crate compiles for wasip1 as-is: the wasm-bindgen
# /web-sys deps (used by the web demo) are compiled but their JS
# imports are dead code for the CLI binary and get garbage-collected
# at link time, so the result is a pure WASI module that runs under
# @wasmer/wasi with no JS glue.
#
# Usage:
#   ./build-wasm-sh2perl.sh
#   SH2PERL_DIR=/some/existing/clone ./build-wasm-sh2perl.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
UPSTREAM="https://github.com/gmatht/sh2perl.git"
TARGET=wasm32-wasip1

# 1. Find or clone the upstream project
SRC="${SH2PERL_DIR:-}"
if [[ -z "$SRC" ]]; then
  if [[ -d "$REPO/build/sh2perl-wasm/.git" ]]; then
    SRC="$REPO/build/sh2perl-wasm"
  elif [[ -d "/tmp/sh2perl/.git" ]]; then
    SRC="/tmp/sh2perl"
  else
    SRC="$REPO/build/sh2perl-wasm"
    echo "Cloning $UPSTREAM ..."
    mkdir -p "$(dirname "$SRC")"
    git clone --depth 1 "$UPSTREAM" "$SRC"
  fi
fi
echo "Using upstream checkout: $SRC"
cd "$SRC"

# 2. Make sure the wasm32-wasip1 target is installed (needs the
# standard library compiled for wasm; rustup installs it on demand)
if command -v rustup >/dev/null 2>&1 \
   && ! rustup target list --installed | grep -q "^$TARGET$"; then
  echo "Adding rust target $TARGET ..."
  rustup target add "$TARGET"
fi

# 3. Build the debashc CLI (the "sh2perl" command) for wasm32-wasip1
echo "== Building debashc (sh2perl) for $TARGET =="
cargo build --release --locked --target "$TARGET" --bin debashc

# 4. Install into the shell's wasm-bin
DEST="$REPO/www/wasm-bin/sh2perl.wasm"
mkdir -p "$(dirname "$DEST")"
cp "target/$TARGET/release/debashc.wasm" "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install sh2perl"
echo "                  sh2perl parse --perl 'echo hello world'"
echo "                  sh2perl file /home/script.sh"
