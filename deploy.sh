#!/bin/bash
# ─── deploy.sh — gated deploy: harnesses must pass before anything ships ──
#
# Refuses to deploy when:
#   • the working tree has uncommitted changes (git push deploys main,
#     rsync deploys the tree — they must agree), or
#   • any gate in deploy-gates.sh fails (harnesses, c-sh-go corpus,
#     www/index.html parse) — the SAME gates the GitHub Pages workflow
#     runs before publishing to gmatht.github.io.
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
  git status --short | head -20 >&2 || true
  if [ "$ALLOW_DIRTY" != true ]; then exit 1; fi
  echo "  (--allow-dirty: deploying the tree as-is)"
fi

# ── gates 2+3+4: shared with the GitHub Pages workflow ─────────────
# deploy-gates.sh runs the harnesses, the c-sh-go corpus and the
# www/index.html parse; .github/workflows/pages.yml runs the same
# script before the Pages build, so gmatht.github.io gets identical
# checks to ca.dansted.org even for pushes that bypass deploy.sh.
if [ "$SKIP_TESTS" != true ]; then
  ./deploy-gates.sh
fi

# ── deploy ──────────────────────────────────────────────────────────
# Targets: ca.dansted.org's PUBLIC host (racknerd, 72.11.150.147 — where
# the DNS points and the user actually loads the site) + the eu origin
# (81.4.105.17) as backup, + gh-pages (auto via the push — gated in CI
# by pages.yml, which runs deploy-gates.sh before the Pages build).
echo "── deploy ──"
SHA=$(git rev-parse HEAD)
git push origin main
echo "commit: $SHA built: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.txt
cp www-landing.html index.html
for HOST in root@72.11.150.147 us; do
  rsync -az --delete www/ "$HOST:/var/www/html/j.cmd/www/"
  rsync -az --delete src/ "$HOST:/var/www/html/j.cmd/src/"
  rsync -az index.html version.txt SECURITY.md "$HOST:/var/www/html/j.cmd/"
done
ssh -o ConnectTimeout=8 root@72.11.150.147 "curl -s -o /dev/null -w 'public: %{http_code}\n' http://localhost/j.cmd/version.txt"
ssh -o ConnectTimeout=8 us "curl -s -o /dev/null -w 'origin:  %{http_code}\n' http://localhost/j.cmd/version.txt"

# A GitHub Pages push is asynchronous.  The old check below only verified
# that GitHub returned *some* HTTP 200, so a failed/cancelled Pages workflow
# was reported as a successful deploy while the site continued serving the
# previous commit.  Wait for the build stamp produced by pages.yml instead.
# Add a query string so a cached version.txt cannot make an old deployment
# look current.
PAGES_VERSION_URL="https://gmatht.github.io/j.cmd/www/version.txt"
PAGES_READY=false
for attempt in $(seq 1 30); do
  pages_version=$(curl -fsS --max-time 20 \
    "${PAGES_VERSION_URL}?deploy=${SHA}" 2>/dev/null || true)
  if printf '%s\n' "$pages_version" | grep -Fq "commit: $SHA"; then
    PAGES_READY=true
    echo "gh-pages: 200 ($SHA)"
    break
  fi
  if [ "$attempt" -lt 30 ]; then
    echo "gh-pages: waiting for Pages workflow ($attempt/30)"
    sleep 20
  fi
done
if [ "$PAGES_READY" != true ]; then
  echo "✗ GitHub Pages did not publish $SHA" >&2
  echo "  The push succeeded, but the Pages workflow may have failed;" >&2
  echo "  inspect: https://github.com/gmatht/j.cmd/actions/workflows/pages.yml" >&2
  exit 1
fi
echo "✓ deployed $(git rev-parse --short HEAD)"
