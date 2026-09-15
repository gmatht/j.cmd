#!/bin/bash
# ─── build-wasm-awk.sh ─────────────────────────────────────────
# Build a real awk (busybox's awk applet — the standard POSIX
# implementation used on embedded Linux) into a wasm32-wasi binary
# that the browser shell runs as a native command.
#
# Same pipeline as build-wasm-grep.sh: busybox allnoconfig with just
# CONFIG_AWK (+ CONFIG_LFS), compiled with the wasi-sdk, the libbb
# x86-assembly hashes and network helpers dropped, and the wasi
# emulated-* libraries linked for the pieces awk actually uses.
#
# Usage:
#   ./build-wasm-awk.sh
#   WASI_SDK=/opt/wasi-sdk-25.0-x86_64-linux ./build-wasm-awk.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CLANG="$WASI_SDK/bin/clang"
AR="$WASI_SDK/bin/llvm-ar"
NM="$WASI_SDK/bin/llvm-nm"
RANLIB="$WASI_SDK/bin/llvm-ranlib"
STRIP="$WASI_SDK/bin/llvm-strip"

BUILD="$REPO/build/awk-wasm"
TC="$BUILD/toolchain"
STUBS="$BUILD/stubs"
BB_DIR="$BUILD/busybox"
mkdir -p "$TC" "$STUBS"

# Toolchain symlinks — busybox expects $(CROSS_COMPILE)gcc, ar, nm, strip...
ln -sf "$CLANG" "$TC/wasm32-wasi-gcc"
ln -sf "$CLANG" "$TC/wasm32-wasi-cc"
ln -sf "$AR" "$TC/wasm32-wasi-ar"
ln -sf "$NM" "$TC/wasm32-wasi-nm"
ln -sf "$RANLIB" "$TC/wasm32-wasi-ranlib"
ln -sf "$STRIP" "$TC/wasm32-wasi-strip"
export CROSS_COMPILE="$TC/wasm32-wasi-"

# Reuse the grep build's stub headers (the same POSIX API wasi-libc
# hides behind __wasilibc_unmodified_upstream).
if [[ -d "$REPO/build/grep-wasm/stubs" ]]; then
  cp -r "$REPO/build/grep-wasm/stubs/." "$STUBS/"
else
  echo "ERROR: build/grep-wasm/stubs missing — run build-wasm-grep.sh first" >&2
  exit 1
fi
# awk's system() / `cmd | getline` need popen/pclose (stubbed at link)
cat >> "$STUBS/wasi_compat.h" << 'EOF'
#include <stdio.h>
FILE *popen(const char *, const char *);
int pclose(FILE *);
EOF

CFLAGS="-I$STUBS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -include wasi_compat.h"
LDFLAGS="-Wl,--undefined=main -Wl,--undefined=__main_argc_argv"

# awk's system() / `cmd | getline` need popen/pclose, which wasi-libc
# doesn't provide (no fork/exec). Stub them: the callers check the
# return, so system()/pipe-getline fail gracefully at runtime while the
# core awk text processing (fields, patterns, actions, printf) works.
# Compiled into libbb (NOT via EXTRA_LDFLAGS — that would fold the stub
# into every built-in.o and duplicate the symbols).
cat > "$BUILD/popen_stub.c" << 'EOF'
#include <stdio.h>
FILE *popen(const char *cmd, const char *mode) { (void)cmd; (void)mode; return NULL; }
int pclose(FILE *f) { (void)f; return -1; }
EOF
cp "$BUILD/popen_stub.c" "$BB_DIR/libbb/popen_stub.c"
sed -i '/^lib-y += alloc_affinity.o$/a lib-y += popen_stub.o' "$BB_DIR/libbb/Kbuild.src"

# 3. Busybox source (the same fork the grep build uses)
UPSTREAM="https://github.com/gmatht/busybox.git"
if [[ ! -d "$BB_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BB_DIR")"
  echo "Cloning busybox from $UPSTREAM ..."
  git clone --depth 1 "$UPSTREAM" "$BB_DIR"
fi
echo "Using busybox checkout: $BB_DIR"
cd "$BB_DIR"

# 4. Minimal config: awk only (no shell — wasm has no fork/exec)
make clean >/dev/null 2>&1 || true
make allnoconfig
sed -i 's/# CONFIG_AWK is not set/CONFIG_AWK=y/; s/# CONFIG_LFS is not set/CONFIG_LFS=y/' .config
make oldconfig </dev/null >/dev/null
# oldconfig defaults the shell to ash; disable it (needs fork/exec)
sed -i 's/^CONFIG_SHELL_ASH=y/# CONFIG_SHELL_ASH is not set/;
        s/^CONFIG_SH_IS_ASH=y/# CONFIG_SH_IS_ASH is not set/;
        s/^# CONFIG_SH_IS_NONE is not set/CONFIG_SH_IS_NONE=y/;
        s/^CONFIG_ASH=y/# CONFIG_ASH is not set/' .config
sed -i 's/^CONFIG_EXTRA_LDLIBS=""/CONFIG_EXTRA_LDLIBS="-lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks"/' .config

# 5. Drop x86-only assembly hashes and the network helpers from libbb
# (awk doesn't need them; the .S files don't assemble for wasm and the
# network files need a full socket API wasi doesn't have).
sed -i '/^lib-y += hash_sha1_x86-64.o$/d;
        /^lib-y += hash_sha1_hwaccel_x86-64.o$/d;
        /^lib-y += hash_sha1_hwaccel_x86-32.o$/d;
        /^lib-y += hash_sha256_hwaccel_x86-64.o$/d;
        /^lib-y += hash_sha256_hwaccel_x86-32.o$/d;
        /^lib-y += herror_msg.o$/d;
        /^lib-y += inet_common.o$/d;
        /^lib-y += xconnect.o$/d' libbb/Kbuild.src

# wasm-ld rejects --start-group/--end-group (it uses --start-lib); the
# trylink probe runs with the HOST compiler so it wrongly passes. Force
# them off so the cross link succeeds.
sed -i 's/^START_GROUP="-Wl,--start-group"/START_GROUP=""/;
        s/^END_GROUP="-Wl,--end-group"/END_GROUP=""/;
        s/echo "-Wl,--warn-common -Wl,-Map,$EXE.map -Wl,--verbose"/echo "-Wl,-Map,$EXE.map"/' scripts/trylink

# 6. Build (parallel — busybox's own rules are fine with -j)
echo "== Building busybox awk for wasm32-wasi =="
make busybox -j"$(nproc)" \
  EXTRA_CFLAGS="$CFLAGS" \
  EXTRA_LDFLAGS="$LDFLAGS" >/dev/null

# 7. Install into the shell's wasm-bin
DEST="$REPO/www/wasm-bin/awk.wasm"
mkdir -p "$(dirname "$DEST")"
cp busybox "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install awk  →  echo 'a b' | awk '{print \$2}'"
