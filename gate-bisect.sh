#!/bin/bash
# ─── gate-bisect.sh ─────────────────────────────────────────────
# Bisect a transpile failure by layer: tells you whether the breakage
# is in the UPSTREAM frontend, the VENDORED copy, the BUSYBOX wasm, or
# the BACKEND render — so you fix the right repo instead of guessing.
#
# The four layers, cheapest first (a layer that passes exonerates
# everything beneath it for this input):
#   0. SYNC-CHECK .... vendored www/bin/<frontend>/ vs sh2loop working
#                      tree (stale vendor explains most "it worked
#                      yesterday" mysteries)
#   1. UPSTREAM-NATIVE  the real Go frontend via `go run` (needs a Go
#                      toolchain; library-only frontends get a compile
#                      check instead)
#   2. BUSYBOX-WASM ... busyboxA1() through the PREBUILT
#                      www/wasm-bin/otranspiler-busybox.wasm
#   3. RENDER-JS ...... otranspilerl render to the js backend
#   4. RUN ............ not attempted (needs a harness) — prints the
#                      one-liner to finish the check by hand
#
# Usage:
#   ./gate-bisect.sh www/examples/c/foo.c c
#   ./gate-bisect.sh www/examples/py/t98_list_growth_neg100min.py py
#   SH2LOOP=/path/to/sh2loop ./gate-bisect.sh <file> <lang>
# Exit 0 if every runnable stage passes, 1 otherwise.
# -----------------------------------------------------------------

set -uo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SH2LOOP="${SH2LOOP:-/home/llm/sh2loop}"
FILE="${1:-}"; LANG="${2:-}"
[ -f "$FILE" ] || { echo "usage: $0 <file> <srclang>" >&2; exit 2; }
[ -n "$LANG" ] || { echo "usage: $0 <file> <srclang>" >&2; exit 2; }

# srclang:frontend-dir:cli-subpath(empty = library-only)
case "$LANG" in
  bat)  FE="bat-sh-go";      CLI="cmd/bat-sh-go/main.go" ;;
  c)    FE="c-sh-go";        CLI="cmd/c-sh-go/main.go" ;;
  cpp)  FE="cpp-sh-go";      CLI="" ;;
  cpp)  FE="cpp-sh-go";      CLI="" ;;
  fish) FE="fish-sh-go";     CLI="cmd/fish-sh-go/main.go" ;;
  go)   FE="go-sh";          CLI="cmd/go-sh/main.go" ;;
  pl|perl) FE="perl-sh-go";  CLI="cmd/perl-sh-go/main.go" ;;
  py)   FE="py-sh-go";       CLI="cmd/py-sh-go/main.go" ;;
  sh)   FE="posix-sh-go";    CLI="" ;;
  zsh)  FE="zsh-sh-go";      CLI="cmd/zsh-sh-go/main.go" ;;
  zig)  FE="zig-sh-go";      CLI="cmd/zig-sh-go/main.go" ;;
  *) echo "unknown srclang: $LANG" >&2; exit 2 ;;
esac

FAIL=0
say() { printf '%-16s: %s\n' "$1" "$2"; }

# ── 0. sync check ────────────────────────────────────────────────
# (cpp-sh-go is hand-managed — upstream is cgo, only main.go is vendored
# and parser.go is deliberately absent; skip it here)
if [ "$FE" = "cpp-sh-go" ]; then
  if diff -q "$REPO/www/bin/cpp-sh-go/main.go" "$SH2LOOP/frontends/cpp-sh-go/main.go" >/dev/null 2>&1; then
    say "0 SYNC-CHECK" "pure-Go tokenizer matches upstream"
  else
    say "0 SYNC-CHECK" "differs by policy (vendored pure-Go tokenizer vs upstream cgo — see sync-frontends.sh)"
  fi
else
STALE=0
while IFS= read -r f; do
  [ -f "$SH2LOOP/frontends/$FE/$f" ] || continue
  diff -q "$REPO/www/bin/$FE/$f" "$SH2LOOP/frontends/$FE/$f" >/dev/null 2>&1 || {
    # go-sh.go and bat.go differ BY DESIGN (vendored adapters)
    case "$FE/$f" in go-sh/go-sh.go|bat-sh-go/bat.go) ;; *) STALE=1; echo "  stale: $FE/$f";; esac
  }
done < <(cd "$REPO/www/bin/$FE" && find . -name '*.go' -not -path './testdata/*' | sed 's|^\./||')
[ "$STALE" = 0 ] && say "0 SYNC-CHECK" "vendored matches upstream" || { say "0 SYNC-CHECK" "STALE — run ./sync-frontends.sh"; FAIL=1; }
fi

# ── 1. upstream native ───────────────────────────────────────────
if command -v go >/dev/null 2>&1; then
  if [ -n "$CLI" ] && [ -f "$SH2LOOP/frontends/$FE/$CLI" ]; then
    case "$FILE" in /*) ABSFILE="$FILE";; *) ABSFILE="$REPO/$FILE";; esac
    OUT=$(cd "$SH2LOOP/frontends/$FE" && timeout 120 go run "./$(dirname "$CLI")" --shir "$ABSFILE" 2>&1); URC=$?
    if [ "$URC" = 0 ] && [ -n "$OUT" ] && ! printf '%s' "$OUT" | grep -qiE "REFUSE|error|panic"; then
      say "1 UPSTREAM" "OK ($(printf '%s' "$OUT" | wc -c) bytes of A1)"
    else
      say "1 UPSTREAM" "FAIL — $(printf '%s' "$OUT" | head -1 | cut -c1-100)"; FAIL=1
    fi
  else
    if (cd "$SH2LOOP/frontends/$FE" && timeout 120 go build ./... 2>&1 | head -3); then
      say "1 UPSTREAM" "OK (library-only frontend compiles; no CLI to run)"
    else
      say "1 UPSTREAM" "FAIL (does not compile)"; FAIL=1
    fi
  fi
else
  say "1 UPSTREAM" "SKIP (no Go toolchain)"
fi

# ── 2+3. busybox wasm + js render ────────────────────────────────
STAGE23=$(node --input-type=module - "$FILE" "$LANG" <<'EOF' 2>&1
import { fs } from './src/fs/index.js';
import { GoRunner } from './src/go.js';
import { busyboxA1 } from './src/busybox.js';
import { getOtranspilerl } from './src/otranspilerl.js';
const [file, lang] = process.argv.slice(2);
const { readFile } = await import('node:fs/promises');
const goRunner = new GoRunner(fs, { baseUrl: 'www/' });
let fail = 0;
try {
  await fs.writeBlob('/usr/bin/bb-bisect.wasm', new Blob([new Uint8Array(await readFile('www/wasm-bin/otranspiler-busybox.wasm'))]));
  const src = await readFile(file, 'utf8');
  const a1 = await busyboxA1(src, lang, { fs, wasmPath: '/usr/bin/bb-bisect.wasm', goRunner });
  console.log('2 BUSYBOX-WASM|' + 'OK (' + JSON.stringify(a1).length + ' bytes of A1)');
  try {
    const lib = await getOtranspilerl();
    const rendered = lib.render(JSON.stringify(a1), 'js');
    console.log('3 RENDER-JS|' + 'OK (' + String(rendered).length + ' bytes of JS)');
  } catch (e) { console.log('3 RENDER-JS|' + 'FAIL — ' + String(e.message).split('\n')[0].slice(0, 120)); process.exitCode = 1; }
} catch (e) { console.log('2 BUSYBOX-WASM|' + 'FAIL — ' + String(e.message).split('\n')[0].slice(0, 120)); process.exitCode = 1; }
EOF
)
NORC=$?
while IFS= read -r line; do say "$(printf '%s' "$line" | cut -d'|' -f1)" "$(printf '%s' "$line" | cut -d'|' -f2-)"; done <<< "$STAGE23"
[ "$NORC" = 0 ] || FAIL=1

# ── 4. run ───────────────────────────────────────────────────────
say "4 RUN" "SKIP (needs a harness) — e.g. adapt __my_qsort-test.mjs, or: source the file in jtsh and compare stdout vs native"

[ "$FAIL" = 0 ] && echo "ALL RUNNABLE STAGES PASS" || echo "FAILURE ABOVE — fix that layer first"
exit "$FAIL"
