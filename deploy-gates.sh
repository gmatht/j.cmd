#!/bin/bash
# ─── deploy-gates.sh — the shared sanity gates for every deploy path ──
#
# Gates 2–4 from deploy.sh, extracted so the GitHub Pages workflow runs
# EXACTLY the same checks as a ca.dansted.org deploy:
#   • the harness tests
#   • the c-sh-go C corpus parse
#   • the www/index.html module parse (node --check + module-scope dupes)
#
# deploy.sh calls this before rsync/push; .github/workflows/pages.yml
# calls it before assembling the Pages site — a push to main that never
# goes through deploy.sh gets the same protection as the rsync host.
#
# Exit 0 = all gates pass, non-zero = refuse to deploy.
# (Gate 1 — a clean git tree — only applies to deploy.sh: it ships the
# working tree via rsync and main via push, so they must agree; CI
# always checks out clean.)
set -euo pipefail
cd "$(dirname "$0")"

TESTS=(__mini-test.mjs __my_qsort-test.mjs __linked-list-test.mjs __qsort-builtin-test.mjs __shell-regression.mjs __shader-test.mjs __sound-test.mjs __sideface-test.mjs __sideblocks-test.mjs __frag-example-test.mjs __texture-test.mjs __flash-test.mjs __claim2-live.mjs)

# ── gates 2+3: the harnesses and the C corpus ───────────────────────
echo "── harnesses ──"
for t in "${TESTS[@]}"; do
  log="/tmp/deploy-$(basename "$t" .mjs).log"
  printf '  %-26s ' "$t"
  # __sound-test.mjs boots mimecroft twice and synthesises every
  # sound under real bash (per-sample DSP — the 460 ms treasure is
  # ~10K samples) — give it a longer window than the unit tests
  tl=150
  if [ "$t" = "__sound-test.mjs" ]; then tl=240; fi
  # the texture generators are per-pixel bash (value-noise DSP) — the
  # four 64×64 MIME-name textures (jpeg/octet/png/text) are ~15-18 s
  # EACH under real bash, and the wasm transpile phase is CPU-bound:
  # observed totals 164-212 s, so 240 s is a coin flip on a loaded box
  if [ "$t" = "__texture-test.mjs" ]; then tl=300; fi
  if timeout $tl node "$t" > "$log" 2>&1; then
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

# ── gate 4: the browser app must PARSE (module-scope duplicates and stray
# brace/comma artifacts from automated edits have broken the page twice) ──
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
# ctx shorthand keys must resolve to module-scope declarations/imports
i = big.find("const shellCtx = {")
if i >= 0:
    seg = big[i:i+6000]
    for s in re.findall(r"^\s{2}([A-Za-z_$][\w$]*),$", seg, re.M):
        if not re.search(r"^(?:const|let|var|function|async function|class)\s+" + re.escape(s) + r"\b", big, re.M) \
           and not re.search(r"^import [^;]*\b" + re.escape(s) + r"\b[^;]*;", big, re.M):
            print("ctx shorthand not in scope:", s); sys.exit(1)
PY
if node --check /tmp/deploy-app-check.js > /tmp/deploy-app-check.log 2>&1; then
  echo "  www/index.html module parses"
else
  echo "✗ www/index.html module syntax error — refusing to deploy" >&2
  head -3 /tmp/deploy-app-check.log >&2
  exit 1
fi
