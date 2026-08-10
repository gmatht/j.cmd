#!/bin/bash
# ─── deploy.sh — gated deploy: harnesses must pass before anything ships ──
#
# Refuses to deploy when:
#   • the working tree has uncommitted changes (git push deploys main,
#     rsync deploys the tree — they must agree), or
#   • any harness fails, or
#   • any example C file stops parsing through the c-sh-go frontend.
#
# On success it pushes main (auto GitHub Pages), rsyncs www/ + src/ +
# version.txt + the landing index.html to ca.dansted.org, and verifies
# both are reachable.
#
# Usage (from the repo root):
#   ./deploy.sh                  # test + deploy current main
#   ./deploy.sh --allow-dirty    # deploy the tree even with edits (still tests)
#   ./deploy.sh --skip-tests     # emergency: deploy without testing
#
# If the C frontend changed, rebuild the busybox wasm FIRST (the tests
# and the site both use www/wasm-bin/otranspiler-busybox.wasm):
#   ./build-wasm-busybox.sh && bump BUSYBOX_VERSION in src/busybox.js
# …then commit everything and run ./deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"

TESTS=(__mini-test.mjs __my_qsort-test.mjs __linked-list-test.mjs __qsort-builtin-test.mjs)
ALLOW_DIRTY=false
SKIP_TESTS=false
for a in "$@"; do
  case "$a" in
    --allow-dirty) ALLOW_DIRTY=true ;;
    --skip-tests)  SKIP_TESTS=true ;;
    *) echo "usage: $0 [--allow-dirty] [--skip-tests]" >&2; exit 2 ;;
  esac
done

# ── gate 1: the tree must be the deploy state ───────────────────────
if ! git diff --quiet; then
  echo "✗ uncommitted changes — commit them first (git push ships main, rsync ships the tree)" >&2
  git status --short | head -20 >&2
  if [ "$ALLOW_DIRTY" != true ]; then exit 1; fi
  echo "  (--allow-dirty: deploying the tree as-is)"
fi

# ── gates 2+3: the harnesses and the C corpus ───────────────────────
if [ "$SKIP_TESTS" != true ]; then
  echo "── harnesses ──"
  for t in "${TESTS[@]}"; do
    log="/tmp/deploy-$(basename "$t" .mjs).log"
    printf '  %-26s ' "$t"
    if timeout 150 node "$t" > "$log" 2>&1; then
      echo "PASS"
    else
      echo "FAIL — refusing to deploy (log: $log)"
      tail -15 "$log" >&2
      exit 1
    fi
  done

  echo "── c-sh-go corpus ──"
  CB=/tmp/cshgo-check
  if [ ! -x "$CB" ]; then
    echo "  building c-sh-go frontend…"
    (cd www/bin/c-sh-go && GOOS=linux GOARCH=amd64 go build -o "$CB" ./cmd/c-sh-go)
  fi
  files=(www/examples/*.c www/examples/c/*.c)
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    if ! "$CB" --shir "$f" --raw > /dev/null 2>/tmp/deploy-corpus.log; then
      echo "  ✗ $f: $(head -1 /tmp/deploy-corpus.log)" >&2
      exit 1
    fi
  done
  echo "  ${#files[@]} example .c files parse"
fi

# ── gate 4: the browser app must PARSE (module-scope duplicates and stray
# brace/comma artifacts from automated edits have broken the page twice) ──
if [ "$SKIP_TESTS" != true ]; then
  python3 - <<'PY' || { echo "✗ www/index.html module fails to parse — refusing to deploy" >&2; exit 1; }
import re, collections, sys
html = open("www/index.html").read()
blocks = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
big = max(blocks, key=len)
open("/tmp/deploy-app-check.js", "w").write(big)
decls = re.findall(r"^(?:export )?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)", big, re.M)
dups = {k: v for k, v in collections.Counter(decls).items() if v > 1}
if dups:
    print("module-scope duplicates:", dups); sys.exit(1)
if re.search(r",\s*,|\}\s*\},\s*\},|\}\s*\}\s*\},\s*\{", big):
    print("stray brace/comma artifact"); sys.exit(1)
PY
  if node --check /tmp/deploy-app-check.js > /tmp/deploy-app-check.log 2>&1; then
    echo "  www/index.html module parses"
  else
    echo "✗ www/index.html module syntax error — refusing to deploy" >&2
    head -3 /tmp/deploy-app-check.log >&2
    exit 1
  fi
fi

# ── deploy ──────────────────────────────────────────────────────────
echo "── deploy ──"
SHA=$(git rev-parse HEAD)
git push origin main
echo "commit: $SHA built: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.txt
rsync -az --delete www/ us:/var/www/html/j.cmd/www/
rsync -az --delete src/ us:/var/www/html/j.cmd/src/
cp www-landing.html index.html
rsync -az index.html version.txt us:/var/www/html/j.cmd/
ssh us "curl -s -o /dev/null -w 'origin:  %{http_code}\n' http://localhost/j.cmd/version.txt"
curl -s -o /dev/null -w "gh-pages: %{http_code}\n" https://gmatht.github.io/j.cmd/www/version.txt
echo "✓ deployed $(git rev-parse --short HEAD)"
