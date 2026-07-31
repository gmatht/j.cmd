#!/bin/bash
# ─── todo-runner.sh ─────────────────────────────────────────────
# Work through TODO.md one item at a time, using pi (the coding
# agent) to implement each item. After each item, new source files
# are git-added (build artifacts excluded via .gitignore) and the
# item is marked done. Loops until every item is complete.
#
# Usage:
#   ./todo-runner.sh                 # run all pending items
#   ./todo-runner.sh --limit 3       # run at most 3 items
#   ./todo-runner.sh --dry-run       # show what would run
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
LIMIT=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cd "$REPO"

# Parse TODO.md → one unchecked item per line: "LINENO<TAB>TEXT"
parse_todo() {
  python3 - <<'PYEOF'
import re, sys
path = "TODO.md"
lines = open(path).read().split("\n")
items = []
current = None
for i, line in enumerate(lines, 1):
    m = re.match(r"^- \[ \] (.*)$", line)
    if m:
        if current:
            items.append(current)
        current = {"line": i, "text": m.group(1), "cont": []}
    elif current and line.startswith("      "):
        current["cont"].append(line.strip())
if current:
    items.append(current)
for it in items:
    text = it["text"]
    if it["cont"]:
        text += " " + " ".join(it["cont"])
    print(f"{it['line']}\t{text}")
PYEOF
}

commit_if_changes() {
  local msg="$1"
  if ! git diff --quiet && ! git diff --cached --quiet; then
    git add -A
    git commit -m "$msg" >/dev/null 2>&1 || true
  elif ! git diff --quiet; then
    git add -A
    git commit -m "$msg" >/dev/null 2>&1 || true
  elif ! git diff --cached --quiet; then
    git commit -m "$msg" >/dev/null 2>&1 || true
  fi
}

count=0
while true; do
  ITEM=$(parse_todo | head -1 || true)
  if [[ -z "$ITEM" ]]; then
    echo "=== All TODO items complete! ==="
    break
  fi
  if [[ -n "$LIMIT" ]] && (( count >= LIMIT )); then
    echo "=== Limit reached ($LIMIT items) — stopping ==="
    break
  fi

  LINE="${ITEM%%$'\t'*}"
  TEXT="${ITEM#*$'\t'}"
  count=$((count + 1))

  echo ""
  echo "━━━ Item $count (line $LINE): $TEXT ━━━"

  if [[ "$DRY_RUN" == true ]]; then
    echo "  [dry-run] would run pi on: $TEXT"
    # Mark done in dry-run so we can preview the whole list
    sed -i "${LINE}s/^- \[ \]/- [x]/" TODO.md
    continue
  fi

  # Let pi implement this single item
  pi -p --cwd "$REPO" \
    "You are working on the sh2runtime project (a browser shell). Complete THIS ONE TODO item: \"$TEXT\". \
     Make the change, run a quick sanity check, commit with a descriptive message, \
     then mark the item done in TODO.md by replacing '- [ ]' with '- [x]' on line $LINE. \
     Respect .gitignore (do NOT commit build artifacts). Do not stop until this single item is done."

  # Ensure new source files are staged (gitignore filters build artifacts)
  commit_if_changes "todo: $TEXT"

  # Defensively mark the item done if pi didn't
  sed -i "${LINE}s/^- \[ \]/- [x]/" TODO.md
  commit_if_changes "Mark TODO done: ${TEXT:0:60}"
done

echo ""
echo "Runner finished. ${count} item(s) processed."
