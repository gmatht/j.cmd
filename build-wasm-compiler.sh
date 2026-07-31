#!/bin/bash
# ─── build-wasm-compiler.sh ────────────────────────────────────
# Build the steinerkelvin/c-to-wasm-compiler-project C→WASM
# compiler (a C compiler written in C++ that emits WebAssembly)
# into a wasm32-wasi binary the browser shell can run.
#
# Pipeline:
#   1. Clone the upstream repo (or reuse an existing clone)
#   2. Apply wasm-compiler.patch — clang-18 include fixes
#      (<cstdint>, <algorithm>, <optional>) + optional file arg
#   3. Native build sanity check (make exe; needs flex/bison/clang)
#   4. Cross-compile every source with the wasi-sdk to wasm32-wasi
#      (-fno-exceptions: wasi-sdk's libc++abi ships no exception
#      runtime; the compiler code never throws, so this is free)
#   5. Drop the result in www/wasm-bin/compiler.wasm
#
# Usage:
#   ./build-wasm-compiler.sh
#   WASI_SDK=/opt/wasi-sdk-24.0-x86_64-linux ./build-wasm-compiler.sh
#   C2W_DIR=/some/existing/clone ./build-wasm-compiler.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PATCH="$REPO/wasm-compiler.patch"
UPSTREAM="https://github.com/steinerkelvin/c-to-wasm-compiler-project.git"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CXX="$WASI_SDK/bin/wasm32-wasi-clang++"
CXXFLAGS="-std=c++17 -O2 -Wall -fno-exceptions -Isrc"

# 1. Find or clone the upstream project
C2W_DIR="${C2W_DIR:-}"
if [[ -z "$C2W_DIR" ]]; then
  if [[ -d "$REPO/build/c-to-wasm-compiler-project/.git" ]]; then
    C2W_DIR="$REPO/build/c-to-wasm-compiler-project"
  elif [[ -d "/tmp/c-to-wasm-compiler-project/.git" ]]; then
    C2W_DIR="/tmp/c-to-wasm-compiler-project"
  else
    C2W_DIR="$REPO/build/c-to-wasm-compiler-project"
    echo "Cloning $UPSTREAM ..."
    mkdir -p "$(dirname "$C2W_DIR")"
    git clone --depth 1 "$UPSTREAM" "$C2W_DIR"
  fi
fi
echo "Using upstream checkout: $C2W_DIR"
cd "$C2W_DIR"

# 2. Apply the clang-18 fixes (idempotent)
if git apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "Patch already applied — skipping."
else
  echo "Applying wasm-compiler.patch ..."
  git apply "$PATCH"
fi

# 3. Native build sanity check (also regenerates flex/bison output)
echo "== Native build (clang++) =="
make exe

# 4. Cross-compile with the wasi-sdk
echo "== WASM build (wasi-sdk) =="
BUILD=build-wasm
rm -rf "$BUILD"
mkdir -p "$BUILD"

SRCS=""
for f in src/*.cpp; do
  base="$(basename "$f" .cpp)"
  [[ "$base" == "scanner" || "$base" == "generated_parser" ]] && continue
  echo "  $f"
  "$CXX" $CXXFLAGS -c "$f" -o "$BUILD/$base.o"
  SRCS="$SRCS $BUILD/$base.o"
done

# Flex/bison generated scanner + parser (committed to the repo)
for f in src/scanner.cpp src/generated_parser.cpp; do
  base="$(basename "$f" .cpp)"
  echo "  $f"
  "$CXX" $CXXFLAGS -c "$f" -o "$BUILD/$base.o"
  SRCS="$SRCS $BUILD/$base.o"
done

# The compiler driver
echo "  main/compiler.cpp"
"$CXX" $CXXFLAGS -c main/compiler.cpp -o "$BUILD/compiler.o"

echo "Linking compiler.wasm ..."
"$CXX" $CXXFLAGS "$BUILD/compiler.o" $SRCS -o "$BUILD/compiler.wasm"

# 5. Install into the shell's wasm-bin
DEST="$REPO/www/wasm-bin/compiler.wasm"
mkdir -p "$(dirname "$DEST")"
cp "$BUILD/compiler.wasm" "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install compiler  →  compiler prog.c > prog.wat"
