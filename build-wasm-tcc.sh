#!/bin/bash
# ─── build-wasm-tcc.sh ─────────────────────────────────────────
# Build the Tiny C Compiler (TinyCC 0.9.28rc) as wasm32-wasi with a
# wasm32 code target, for the browser shell.
#
# The shell runs wasm32-wasi binaries as native commands (src/wasm.js).
# tcc compiles C straight to wasm INSIDE the shell:
#
#   tcc -c hello.c -o hello.wasm
#   ./hello.wasm
#
# What this script produces (installed into www/wasm-bin/):
#   tcc.wasm          the compiler itself (wasm32-wasi, targets wasm32)
#   tcc-include.dat   gzipped libc headers, staged into /tmp/tcc/include
#                     on first use (src/tcc.js) — tcc's include path is
#                     baked to /tmp/tcc/include at build time
#
# The compiler runs in the WASI sandbox and emits wasm modules whose
# libc calls (printf/puts/malloc/strlen/…) become env.$* imports — the
# shell's env runtime (src/c-runtime.js) provides them when the compiled
# program runs.  varargs work: each distinct call signature becomes its
# own env import (wasm allows same-name imports with different types).
#
# Pipeline:
#   1. Clone TinyCC and apply the wasm32 backend (wasm32-gen.c /
#      wasm32-link.c — in-tree here; the fork lives at
#      /root/src/tinycc-wasm, a wasm32-target branch).
#   2. Configure a cross build: the compiler itself is built with the
#      wasi-sdk clang (so tcc runs on wasm), targeting wasm32 (so its
#      OUTPUT is wasm).
#   3. Patch the wasi-libc headers for tcc (size_t/alloca guards) and
#      bundle them into tcc-include.dat.
#
# Usage:
#   ./build-wasm-tcc.sh
#   TINYCC_DIR=/path/to/tinycc-wasm ./build-wasm-tcc.sh   # reuse a clone
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
TINYCC="${TINYCC_DIR:-$REPO/../tinycc-wasm}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
WORK="$(mktemp -d /tmp/tcc-wasm-build.XXXXXX)"
INC="$WORK/inc"          # header staging dir
trap 'rm -rf "$WORK"' EXIT

if [ ! -x "$WASI_SDK/bin/wasm32-wasi-clang" ]; then
  echo "wasi-sdk not found at $WASI_SDK — set WASI_SDK=/path/to/wasi-sdk" >&2
  exit 1
fi
if [ ! -d "$TINYCC/.git" ]; then
  echo "tinycc fork not found at $TINYCC — set TINYCC_DIR (see wasm32 backend)" >&2
  exit 1
fi

echo "==> configuring tcc (host: wasi clang, target: wasm32)"
(cd "$WORK" && "$TINYCC/configure" \
  --cpu=wasm32 \
  --cc="$WASI_SDK/bin/wasm32-wasi-clang" \
  --sysincludepaths=/tmp/tcc/include \
  --tccdir=/tmp/tcc \
  --libpaths=/tmp/tcc \
  --crtprefix=/tmp/tcc)

# wasi-sdk has no semaphores (tcc's compile lock — single-threaded in the
# shell, so disable it), no setjmp (error recovery only: success paths
# never longjmp — the stub header exits on errors), and the sysroot's
# setjmp.h would #error without the EH proposal (wasmer lacks it).
sed -i \
  -e 's|^AR=ar$|AR='"$WASI_SDK"'/bin/llvm-ar|' \
  -e 's|^CFLAGS=\(.*\)$|CFLAGS=\1 -I'"$WORK"'/stubinc -DCONFIG_TCC_SEMLOCK=0 -DCONFIG_TCCDIR="\\"/tmp/tcc\\""|' \
  "$WORK/config.mak"

mkdir -p "$WORK/stubinc"
cat > "$WORK/stubinc/setjmp.h" <<'EOF'
/* WASI has no setjmp (wasi-sdk's #errors unless -wasm-enable-sjlj, which
 * needs the EH proposal — wasmer doesn't have it). tcc only uses
 * setjmp/longjmp for error recovery: the success path never longjmps.
 * setjmp always "succeeds"; longjmp (an error, already printed) exits. */
#ifndef _SETJMP_H
#define _SETJMP_H
#include <stdlib.h>
typedef struct __jmp_buf_tag { int __jb; } jmp_buf[1];
typedef jmp_buf sigjmp_buf;
#define setjmp(env) 0
#define _setjmp(env) 0
#define longjmp(env, val) _Exit((val) ? (val) : 1)
#define siglongjmp(env, val) _Exit((val) ? (val) : 1)
#endif
EOF

echo "==> building (libtcc1.a fails on purpose — it would run the wasm tcc)"
(cd "$WORK" && make -j"$(nproc)" tcc) || true
WASM="$WORK/tcc"
[ -f "$WASM" ] || { echo "tcc build failed" >&2; exit 1; }
ls -lh "$WASM"

echo "==> staging libc headers (wasi-sdk C headers + tcc's own)"
mkdir -p "$INC"
cp -r "$WASI_SDK/share/wasi-sysroot/include/wasm32-wasi/"* "$INC/"
rm -rf "$INC/c++"
cp "$TINYCC"/include/*.h "$INC/" 2>/dev/null || true

# tcc predeclares size_t/ptrdiff_t/alloca in tccdefs.h — guard them so
# the musl-style wasi headers can coexist (see the fork's include/stddef.h).
if grep -q "__DEFINED_size_t" "$INC/stddef.h" 2>/dev/null; then :; else
  python3 - "$INC/stddef.h" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('''typedef __SIZE_TYPE__ size_t;''',
'''#ifndef __DEFINED_size_t
typedef __SIZE_TYPE__ size_t;
#define __DEFINED_size_t
#endif''')
s = s.replace('''typedef __PTRDIFF_TYPE__ ssize_t;''',
'''#ifndef __DEFINED_ssize_t
typedef __PTRDIFF_TYPE__ ssize_t;
#define __DEFINED_ssize_t
#endif''')
s = s.replace('''typedef __WCHAR_TYPE__ wchar_t;''',
'''#ifndef __DEFINED_wchar_t
typedef __WCHAR_TYPE__ wchar_t;
#define __DEFINED_wchar_t
#endif''')
s = s.replace('''typedef __PTRDIFF_TYPE__ ptrdiff_t;''',
'''#ifndef __DEFINED_ptrdiff_t
typedef __PTRDIFF_TYPE__ ptrdiff_t;
#define __DEFINED_ptrdiff_t
#endif''')
s = s.replace('''typedef __PTRDIFF_TYPE__ intptr_t;''',
'''#ifndef __DEFINED_intptr_t
typedef __PTRDIFF_TYPE__ intptr_t;
#define __DEFINED_intptr_t
#endif''')
s = s.replace('''typedef __SIZE_TYPE__ uintptr_t;''',
'''#ifndef __DEFINED_uintptr_t
typedef __SIZE_TYPE__ uintptr_t;
#define __DEFINED_uintptr_t
#endif''')
open(p, 'w').write(s)
PYEOF
fi

# alloca: wasi's <alloca.h> redeclares it with musl's size_t (unsigned
# long); tcc's builtin is __SIZE_TYPE__ — the declaration conflicts.
python3 - "$INC/alloca.h" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("void *alloca(size_t);",
              "#ifndef __TINYC__\nvoid *alloca(size_t);\n#endif  /* tcc predeclares alloca */")
open(p, 'w').write(s)
PYEOF

echo "==> bundling headers into tcc-include.dat ([TCC1][len][JSON][data], gzip)"
node - "$INC" "$REPO/www/wasm-bin/tcc-include.dat" <<'PYEOF'
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const root = process.argv[2], out = process.argv[3];
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d)) { const p = path.join(d, e); if (fs.statSync(p).isDirectory()) walk(p); else if (e.endsWith(".h")) files.push(p); } };
walk(root);
files.sort();
const index = [];
let data = Buffer.alloc(0);
for (const f of files) {
  const rel = path.relative(root, f);
  const buf = fs.readFileSync(f);
  index.push([rel, data.length, buf.length]);
  data = Buffer.concat([data, buf]);
}
const header = Buffer.from(JSON.stringify(index));
const headerLen = Buffer.alloc(4);
headerLen.writeUInt32LE(header.length, 0);
fs.writeFileSync(out, zlib.gzipSync(Buffer.concat([Buffer.from("TCC1"), headerLen, header, data])));
console.log(`  ${files.length} headers, ${(data.length / 1048576).toFixed(1)}MB raw -> ${(out.length / 1048576).toFixed(2)}MB gzipped`);
PYEOF

echo "==> installing"
cp "$WASM" "$REPO/www/wasm-bin/tcc.wasm"
echo "  www/wasm-bin/tcc.wasm      ($(du -h "$REPO/www/wasm-bin/tcc.wasm" | cut -f1)) — the compiler"
echo "  www/wasm-bin/tcc-include.dat ($(du -h "$REPO/www/wasm-bin/tcc-include.dat" | cut -f1)) — libc headers bundle"
echo "    quick check: node src/jtsh.js (tcc -c hello.c -o hello.wasm && ./hello.wasm)"
