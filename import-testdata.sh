#!/bin/bash
# ─── import-testdata.sh ─────────────────────────────────────────
# Import a frontend's corpus testdata as loadable GUI examples.
#
# otranspiler.html loads per-language example lists from
# www/examples/<lang>/index.json (lazy fetch) — this script copies new
# upstream testdata files in and regenerates the manifest. It never
# deletes destination files (hand-written demos like my_qsort.c live
# alongside the mirrored corpus).
#
# index.json format is load-bearing: a SINGLE-LINE JSON array, items
# separated by ", " — keep it that way (the GUI fetches with a
# cache-buster but some tooling diffs it).
#
# Usage:
#   ./import-testdata.sh py          # py|go|c|cpp|pl|sh|bat|fish|zsh|zig
#   SH2LOOP=/path/to/sh2loop ./import-testdata.sh go
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SH2LOOP="${SH2LOOP:-/home/llm/sh2loop}"
LANG="${1:-}"
[ -n "$LANG" ] || { echo "usage: $0 <py|go|c|cpp|pl|sh|bat|fish|zsh|zig>" >&2; exit 2; }

# lang:upstream-subdir:dest-subdir:space-separated-extensions
case "$LANG" in
  py)   UP="py-sh-go/testdata";      DEST="py";       EXTS="py" ;;
  go)   UP="go-sh/testdata";         DEST="go";       EXTS="go sh" ;;
  c)    UP="c-sh-go/testdata";       DEST="c";        EXTS="c" ;;
  cpp)  UP="cpp-sh-go/testdata_cpp"; DEST="cpp";      EXTS="cc" ;;
  pl)   UP="perl-sh-go/testdata";    DEST="pl";       EXTS="pl" ;;
  sh)   UP="posix-sh-go/testdata";   DEST="sh-posix"; EXTS="sh" ;;
  bat)  UP="bat-sh-go/testdata";     DEST="bat";      EXTS="bat" ;;
  fish) UP="fish-sh-go/testdata";    DEST="fish";     EXTS="fish" ;;
  zsh)  UP="zsh-sh-go/testdata";     DEST="zsh";      EXTS="zsh" ;;
  zig)  UP="zig-sh-go/testdata";     DEST="zig";      EXTS="zig" ;;
  *) echo "unknown lang: $LANG" >&2; exit 2 ;;
esac

SRC="$SH2LOOP/frontends/$UP"
DST="$REPO/www/examples/$DEST"
[ -d "$SRC" ] || { echo "error: no upstream dir $SRC (set SH2LOOP)" >&2; exit 2; }
[ -d "$DST" ] || { echo "error: no dest dir $DST" >&2; exit 2; }

ADDED=0
for ext in $EXTS; do
  for src in "$SRC"/*."$ext"; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    if [ ! -f "$DST/$base" ]; then
      cp "$src" "$DST/$base"
      echo "  + $base"
      ADDED=$((ADDED + 1))
    fi
  done
done

# regenerate the manifest from the destination listing (sorted), preserving
# the file's existing separator style (py uses ",", go uses ", " — both
# parse identically; minimal diffs beat normalization)
python3 - "$DST" <<'EOF'
import json, os, sys
d = sys.argv[1]
files = sorted(f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f)) and f != "index.json")
idx = os.path.join(d, "index.json")
sep = ", "
try:
    old = open(idx).read()
    if '","' in old and '", "' not in old:
        sep = ","
except FileNotFoundError:
    pass
with open(idx, "w") as fh:
    fh.write(json.dumps(files, separators=(sep, ": ")))
print(f"  index.json: {len(files)} entries")
EOF
echo "imported $ADDED new file(s) into www/examples/$DEST/"
