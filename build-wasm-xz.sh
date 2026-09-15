#!/bin/bash
# ─── build-wasm-xz.sh ───────────────────────────────────────
# Build a real xz (busybox's xz applet — the standard
# implementation used on embedded Linux) into a wasm32-wasi binary
# that the browser shell runs as a native command.
#
# Same pipeline as build-wasm-awk.sh: busybox allnoconfig with just
# CONFIG_XZ (+ CONFIG_LFS), compiled with the wasi-sdk, the libbb
# x86-assembly hashes and network helpers dropped, and the wasi
# emulated-* libraries linked for the pieces xz actually uses.
#
# Usage:
#   ./build-wasm-xz.sh
#   WASI_SDK=/opt/wasi-sdk-25.0-x86_64-linux ./build-wasm-xz.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CLANG="$WASI_SDK/bin/clang"
AR="$WASI_SDK/bin/llvm-ar"
NM="$WASI_SDK/bin/llvm-nm"
RANLIB="$WASI_SDK/bin/llvm-ranlib"
STRIP="$WASI_SDK/bin/llvm-strip"

BUILD="$REPO/build/xz-wasm"
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

CFLAGS="-I$STUBS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -include wasi_compat.h"
LDFLAGS="-Wl,--undefined=main -Wl,--undefined=__main_argc_argv"

# 2. wasi-libc compatibility stubs. xz's decompressor uses wait() (only
# 2. wasi-libc compatibility stubs. xz's decompressor uses wait() (only
# in the multi-process path, which is disabled in wasm) — stub it so the
# symbol resolves. busybox also calls dup2() at startup (redirecting fd 2
# to fd 1) and in the unpack path; wasi preview1 has no fd_dup, but it has
# fd_renumber, which is the canonical wasi dup2 (renumbers `from` onto `to`,
# closing `to`). Implement it here.
cat >> "$STUBS/wasi_compat.h" << 'EOF'
#include <sys/types.h>
pid_t wait(int *);
int dup2(int, int);
EOF
cat > "$BUILD/posix_stub.c" << 'EOF'
#include <sys/types.h>
#include <wasi/api.h>
pid_t wait(int *s) { (void)s; return -1; }
int dup2(int from, int to) {
  if (from == to) return to;
  __wasi_errno_t e = __wasi_fd_renumber((__wasi_fd_t)from, (__wasi_fd_t)to);
  if (e != 0) return -1;
  return to;
}
EOF

# 3. Busybox source (the same fork the grep build uses)
UPSTREAM="https://github.com/gmatht/busybox.git"
if [[ ! -d "$BB_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BB_DIR")"
  echo "Cloning busybox from $UPSTREAM ..."
  git clone --depth 1 "$UPSTREAM" "$BB_DIR"
fi
echo "Using busybox checkout: $BB_DIR"
cd "$BB_DIR"

# the posix stubs (wait/dup2) compile into libbb — after the clone
cp "$BUILD/posix_stub.c" "$BB_DIR/libbb/posix_stub.c"
sed -i '/^lib-y += alloc_affinity.o$/a lib-y += posix_stub.o' "$BB_DIR/libbb/Kbuild.src"

# 4. Minimal config: xz only (no shell — wasm has no fork/exec)
make clean >/dev/null 2>&1 || true
make allnoconfig
sed -i 's/# CONFIG_XZ is not set/CONFIG_XZ=y/; s/# CONFIG_LFS is not set/CONFIG_LFS=y/; s/# CONFIG_FEATURE_XZ_DECOMPRESS is not set/CONFIG_FEATURE_XZ_DECOMPRESS=y/' .config
make oldconfig </dev/null >/dev/null
# oldconfig defaults the shell to ash; disable it (needs fork/exec)
sed -i 's/^CONFIG_SHELL_ASH=y/# CONFIG_SHELL_ASH is not set/;
        s/^CONFIG_SH_IS_ASH=y/# CONFIG_SH_IS_ASH is not set/;
        s/^# CONFIG_SH_IS_NONE is not set/CONFIG_SH_IS_NONE=y/;
        s/^CONFIG_ASH=y/# CONFIG_ASH is not set/' .config
sed -i 's/^CONFIG_EXTRA_LDLIBS=""/CONFIG_EXTRA_LDLIBS="-lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks"/' .config

# 5. Drop x86-only assembly hashes and the network helpers from libbb
# (xz doesn't need them; the .S files don't assemble for wasm and the
# network files need a full socket API wasi doesn't have).
sed -i '/^lib-y += hash_sha1_x86-64.o$/d;
        /^lib-y += hash_sha1_hwaccel_x86-64.o$/d;
        /^lib-y += hash_sha1_hwaccel_x86-32.o$/d;
        /^lib-y += hash_sha256_hwaccel_x86-64.o$/d;
        /^lib-y += hash_sha256_hwaccel_x86-32.o$/d;
        /^lib-y += herror_msg.o$/d;
        /^lib-y += inet_common.o$/d;
        /^lib-y += xconnect.o$/d' libbb/Kbuild.src

# wasm-ld rejects --start-group/--end-group and --warn-common (the
# trylink probe runs with the HOST compiler so it wrongly passes).
sed -i 's/^START_GROUP="-Wl,--start-group"/START_GROUP=""/;
        s/^END_GROUP="-Wl,--end-group"/END_GROUP=""/;
        s/echo "-Wl,--warn-common -Wl,-Map,$EXE.map -Wl,--verbose"/echo "-Wl,-Map,$EXE.map"/' scripts/trylink

# The "compressed data not read from terminal" safety check uses isatty,
# which the WASI sandbox reports as a tty even for piped stdin — the
# shell's pipe input is never a real terminal, so drop the check.
sed -i '/compressed data not read from terminal/,+1d' archival/bbunzip.c

# 6. Build (parallel — busybox's own rules are fine with -j)
echo "== Building busybox xz for wasm32-wasi =="
make busybox -j"$(nproc)" \
  EXTRA_CFLAGS="$CFLAGS" \
  EXTRA_LDFLAGS="$LDFLAGS" >/dev/null

# 7. Install into the shell's wasm-bin
DEST="$REPO/www/wasm-bin/xz.wasm"
mkdir -p "$(dirname "$DEST")"
cp busybox "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install xz  →  echo hi | xz | xz -d"
