#!/bin/bash
# ─── build-wasm-zstd.sh ─────────────────────────────────────────
# Build the REAL zstd CLI (facebook/zstd) into a wasm32-wasi binary
# that the browser shell runs as a native command — the same way
# busybox grep became grep.wasm.
#
# zstd compresses to stdout (or <file>.zst), reads stdin with no
# file arguments, and -d decompresses, so the shell's binary-safe
# pipes make `echo hi | zstd | zstd -d` round-trip.
#
# Pipeline:
#   1. Clone facebook/zstd (or reuse build/zstd-wasm/zstd-src/)
#   2. Compile the CLI + lib with the wasi-sdk (wasm32-wasi-clang).
#      The CLI is single-threaded here (no ZSTD_MULTITHREAD — wasm
#      has no pthreads); its POSIX bits (mmap for the dictionary,
#      signals, clocks) come from the wasi emulated-* libraries.
#      Auto-detectable extras (backtrace, sysctl) compile out for
#      non-glibc targets.
#   3. Drop the result in www/wasm-bin/zstd.wasm
#
# Usage:
#   ./build-wasm-zstd.sh
#   WASI_SDK=/opt/wasi-sdk-25.0-x86_64-linux ./build-wasm-zstd.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CLANG="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"

BUILD="$REPO/build/zstd-wasm"
SRC="$BUILD/zstd-src"

if [[ ! -d "$SRC/.git" ]]; then
  mkdir -p "$(dirname "$SRC")"
  echo "Cloning facebook/zstd ..."
  # our fork of facebook/zstd (BSD-3 / GPL-2.0 dual) — see docs/licences.md
  git clone --depth 1 https://github.com/gmatht/zstd.git "$SRC"
fi
echo "Using zstd checkout: $SRC"
cd "$SRC"

# wasm-zstd.patch: the WASI sandbox fs reports uniform st_dev/st_ino, so
# zstd's inode-based same-file check would refuse to decompress (it thinks
# any output "overwrites" the input). Patch UTIL_isSameFileStat to compare
# names instead — the same conservative behaviour zstd uses on Windows.
git checkout -- programs/util.c 2>/dev/null || true
git apply "$REPO/wasm-zstd.patch"

echo "== Building zstd CLI for wasm32-wasi =="
# The CLI's backtrace/sysctl/mman includes are guarded by platform
# detection and compile out or resolve to the wasi emulated-* libs.
# -DZSTD_DISABLE_ASM keeps the decoder fully portable C (the x86-64
# assembly path can't assemble for wasm anyway — this is belt+braces).
# The wasi emulated-* libs + compat header mirror the busybox build:
# signal/clock/mman are emulated, chown is declared manually.
"$CLANG" -O2 --target=wasm32-wasi --sysroot="$SYSROOT" \
  -DZSTD_DISABLE_ASM -DZSTD_NOTRACE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS \
  -include "$BUILD/wasi_compat.h" \
  "$BUILD/stubs.c" \
  -I lib -I lib/common -I programs \
  programs/zstdcli.c programs/fileio.c programs/fileio_asyncio.c \
  programs/dibio.c programs/benchzstd.c programs/benchfn.c \
  programs/datagen.c programs/lorem.c programs/util.c programs/timefn.c \
  lib/decompress/*.c lib/common/*.c lib/compress/*.c lib/dictBuilder/*.c \
  -o zstd.wasm \
  -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -Wl,--undefined=main -Wl,--undefined=__main_argc_argv \
  -Wl,-z,stack-size=1048576

DEST="$REPO/www/wasm-bin/zstd.wasm"
mkdir -p "$(dirname "$DEST")"
cp zstd.wasm "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install zstd  →  echo hi | zstd | zstd -d"
