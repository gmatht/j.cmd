#!/bin/bash
# ─── sync-sh2perl-examples.sh ───────────────────────────────────
# Sync the sh2perl example corpus into www/examples/sh2perl/ and
# regenerate the manifest the web GUI uses to list them.
#
# Source of truth: /root/src/sh2loop/sh2perl/examples/*.sh
# (gmatht/sh2loop — the sh2perl test corpus, ~531 scripts).
#
# The web GUI keeps the corpus SEPARATE from its hand-curated examples:
# it reads only index.json (names) up front and fetches a single .sh
# file when one is clicked — never the whole 2.2MB corpus.
#
# Usage:
#   ./sync-sh2perl-examples.sh            # from the repo root
#   SH2LOOP=/path/to/sh2loop ./sync-sh2perl-examples.sh
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SH2LOOP="${SH2LOOP:-/root/src/sh2loop}"
SRC="$SH2LOOP/sh2perl/examples"
DST="$REPO/www/examples/sh2perl"

if [[ ! -d "$SRC" ]]; then
  echo "sh2perl examples not found at $SRC (set SH2LOOP=…)" >&2
  exit 1
fi

mkdir -p "$DST"
# copy only the plain *.sh scripts (skip .ORIGINAL/.complex scaffolding)
copied=0
for f in "$SRC"/*.sh; do
  name="$(basename "$f")"
  cp "$f" "$DST/$name"
  copied=$((copied + 1))
done

# manifest: sorted names (the GUI fetches contents on demand)
python3 - "$DST" <<'PY'
import json, os, sys
dst = sys.argv[1]
names = sorted(f for f in os.listdir(dst) if f.endswith(".sh"))
with open(os.path.join(dst, "index.json"), "w") as out:
    json.dump(names, out, indent=0)
print(f"manifest: {len(names)} examples")
PY

echo "==> $DST ($(du -sh "$DST" | cut -f1), $copied scripts)"
