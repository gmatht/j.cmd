#!/bin/bash
# ─── build-wasm-markdown.sh ────────────────────────────────────
# Build rsms/markdown-wasm (md4c — the same CommonMark engine
# markdown-wasm npm uses) into a wasm32-wasi CLI: reads stdin or a
# file, writes rendered HTML to stdout. The shell runs it as the
# `markdown` command:
#
#   markdown README.md            → HTML on stdout
#   echo '# hi' | markdown        → <h1>hi</h1>
#   markdown README.md > /pc/x.html
#
# Pipeline:
#   1. Clone https://github.com/rsms/markdown-wasm (or reuse
#      build/markdown-wasm/src/)
#   2. Compile a small WASI CLI wrapper (mdcli.c) + md4c.c +
#      fmt_html.c + wbuf.c with the wasi-sdk. md4c is a single-file
#      CommonMark parser — no external deps, so the CLI is trivial.
#      GitHub-style extensions on: tables, strikethrough, tasklists,
#      permissive autolinks, underline.
#   3. Drop the result in www/wasm-bin/markdown.wasm
#
# Usage:
#   ./build-wasm-markdown.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CLANG="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"

BUILD="$REPO/build/markdown-wasm"
SRC="$BUILD/src"

if [[ ! -d "$SRC/md4c.c" ]]; then
  mkdir -p "$(dirname "$SRC")"
  echo "Cloning rsms/markdown-wasm ..."
  git clone --depth 1 https://github.com/rsms/markdown-wasm.git "$BUILD"
  SRC="$BUILD/src"
fi
echo "Using markdown-wasm checkout: $BUILD"

cat > "$BUILD/mdcli.c" << 'EOF'
/* markdown.wasm — WASI CLI for rsms/markdown-wasm (md4c).
 * Usage: markdown [file.md] — reads stdin or the file, writes HTML.
 * GitHub-ish extensions: tables, strikethrough, tasklists,
 * permissive autolinks, underline. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common.h"
#include "md4c.h"
#include "fmt_html.h"

static char* read_all(FILE* f, size_t* outlen) {
  size_t cap = 65536, len = 0;
  char* buf = malloc(cap);
  if (!buf) return NULL;
  for (;;) {
    if (len == cap) { cap *= 2; char* nb = realloc(buf, cap); if (!nb) { free(buf); return NULL; } buf = nb; }
    size_t n = fread(buf + len, 1, cap - len, f);
    len += n;
    if (n == 0) break;
  }
  *outlen = len;
  return buf;
}

int main(int argc, char** argv) {
  FILE* f = stdin;
  if (argc > 1 && strcmp(argv[1], "-") != 0) {
    f = fopen(argv[1], "rb");
    if (!f) { fprintf(stderr, "markdown: %s: No such file or directory\n", argv[1]); return 1; }
  }
  size_t len;
  char* input = read_all(f, &len);
  if (!input) { fprintf(stderr, "markdown: out of memory\n"); return 1; }
  if (f != stdin) fclose(f);

  WBuf out;
  WBufInit(&out);
  FmtHTML fmt = {
    .flags = OutputFlagHTML,
    .parserFlags = MD_FLAG_TABLES | MD_FLAG_STRIKETHROUGH | MD_FLAG_TASKLISTS |
                   MD_FLAG_PERMISSIVEURLAUTOLINKS | MD_FLAG_PERMISSIVEWWWAUTOLINKS |
                   MD_FLAG_PERMISSIVEEMAILAUTOLINKS | MD_FLAG_UNDERLINE,
    .outbuf = &out,
  };
  int res = fmt_html(input, (MD_SIZE)len, &fmt);
  free(input);
  if (res != 0) {
    fprintf(stderr, "markdown: parse error\n");
    WBufFree(&out);
    return 1;
  }
  fwrite(out.start, 1, WBufLen(&out), stdout);
  fflush(stdout);
  WBufFree(&out);
  return 0;
}
EOF

echo "== Building markdown CLI for wasm32-wasi =="
"$CLANG" -O2 --target=wasm32-wasi --sysroot="$SYSROOT" \
  -I "$SRC" -o "$BUILD/markdown.wasm" \
  "$BUILD/mdcli.c" "$SRC/md4c.c" "$SRC/fmt_html.c" "$SRC/wbuf.c" \
  -Wl,--undefined=main -Wl,--undefined=__main_argc_argv \
  -Wl,-z,stack-size=1048576

DEST="$REPO/www/wasm-bin/markdown.wasm"
mkdir -p "$(dirname "$DEST")"
cp "$BUILD/markdown.wasm" "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install markdown  →  markdown README.md"
