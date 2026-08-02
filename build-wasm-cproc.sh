#!/bin/bash
# ─── build-wasm-cproc.sh ─────────────────────────────────────────
# Build cproc — Michael Forney's C compiler that emits QBE IR — for
# wasm32-wasi, for the browser shell's C pipeline:
#
#   cc prog.c   →  cproc.wasm (-emit-qbe)  →  QBE IR  →  qbe2wasm  →  a.wasm
#
# cproc's frontend (cproc-qbe) is self-contained: built-in preprocessor,
# emits QBE IR to stdout, no subprocesses — exactly what a WASI sandbox
# allows. The shell's cc command preprocesses C (strips #include/#define,
# injects the libc decls matching src/c-runtime.js), runs cproc.wasm with
# -t wasm64 (lp64 — qbe2wasm expects 64-bit QBE 'l' pointers wrapped to
# i32), then translates the IR with qbe2wasm.
#
# The wasm build patches live in our fork gmatht/cproc (configure:
# wasm32 target; driver.c: spawn stubs + wasm target; targ.c: wasm64).
#
# Usage:
#   ./build-wasm-cproc.sh
#   WASI_SDK=/opt/wasi-sdk-25.0-x86_64-linux ./build-wasm-cproc.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CC="$WASI_SDK/bin/wasm32-wasi-clang"
UPSTREAM="https://github.com/gmatht/cproc.git"   # our fork of michaelforney/cproc

BUILD="$REPO/build/cproc-wasm"
rm -rf "$BUILD"
git clone --depth 1 "$UPSTREAM" "$BUILD"

echo "== Building cproc-qbe (wasm32-wasi) =="
cd "$BUILD"
CC=$CC ./configure --with-qbe=none --with-as=none --with-ld=none --with-cpp=none --target=wasm32-unknown-wasi
make CC=$CC CFLAGS="-O2 -Wall"

# 5. Install into the shell
DEST="$REPO/www/wasm-bin/cproc.wasm"
cp cproc-qbe "$DEST"
echo ""
echo "✓ Installed: www/wasm-bin/cproc.wasm ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  cc prog.c && ./a.wasm   (cproc → QBE IR → qbe2wasm)"
