#!/bin/bash
# ─── bug-triage.sh — jtsh bug-report triage ─────────────────────
# The shell's `bug` command files reports as GitHub issues on
# gmatht/j.cmd (label: bug-report). This script fetches them and lets
# you quickly pick the ones to fix:
#
#   ./bug-triage.sh              → list open reports (number · date · title)
#   ./bug-triage.sh show <n>     → full report body for issue #<n>
#   ./bug-triage.sh pick         → walk each report (summary + snippet +
#                                  expected), then choose numbers to fix
#   ./bug-triage.sh close <n>    → mark issue #<n> closed (after fixing)
#
# Requires the gh CLI:  gh auth login
# Set BUG_REPO=owner/repo to point elsewhere.
# -----------------------------------------------------------------
set -euo pipefail
REPO="${BUG_REPO:-gmatht/j.cmd}"

# An issue is a bug report if it has the label, or its title starts
# with "bug:" (label may not exist on repos where no report has been
# filed through a token that could create it).
BUG_FILTER='select(((.labels // []) | map(.name) | index("bug-report")) or (.title | startswith("bug:")))'

cmd_list() {
  gh issue list --repo "$REPO" --state open --limit 200 \
    --json number,title,createdAt,labels -q "
      [ .[] | $BUG_FILTER ] | sort_by(.number)
      | .[] | \"\(.number)\t\(.createdAt[0:10])\t\(.title[0:110])\"" \
    | column -t -s $'\t'
}

cmd_show() {
  local n="$1"
  gh issue view "$n" --repo "$REPO" --json title,state,url,body \
    -q '.title + "\n" + .state + "  " + .url + "\n----\n" + .body'
}

# Print summary/expected/snippet sections of a report body.
# Usage: print_sections <body-file> <number>
print_sections() {
  local f="$1" n="$2"
  echo "  ── #$n ──"
  awk '
    /^## Summary/ {insum=1; next}
    /^## Expected/ {insum=0; inexp=1; next}
    /^## Terminal/ {inexp=0; insnip=1; next}
    /^```/ {if (insnip) {insnip=0; skip=1; next} skip=0; next}
    skip {next}
    insum {if (NF) print "    summary: " $0}
    inexp {if (NF) print "    expected: " $0}
    insnip {print "      | " $0}
  ' "$f"
}

cmd_pick() {
  # Collect open bug reports.
  gh issue list --repo "$REPO" --state open --limit 200 \
    --json number,title,createdAt,labels -q "[ .[] | $BUG_FILTER ] | sort_by(.number) | .[] | .number" \
    > /tmp/bug-triage.nums
  if [ ! -s /tmp/bug-triage.nums ]; then
    echo "No open bug reports (repo: $REPO)."
    return 0
  fi
  local bodyf
  bodyf=$(mktemp)
  echo "Open bug reports:"
  while read -r n; do
    gh issue view "$n" --repo "$REPO" --json body -q .body > "$bodyf"
    print_sections "$bodyf" "$n"
  done < /tmp/bug-triage.nums
  rm -f "$bodyf"
  echo
  echo -n "Fix which? (numbers, comma/space separated, or q) → "
  read -r choice
  case "$choice" in
    q|Q|"") echo "Nothing selected." ;;
    *) for n in $(echo "$choice" | tr ',; ' '   '); do
         case "$n" in ''|*[!0-9]*) continue;; esac
         echo "→ fix #$n  (./bug-triage.sh show $n)"
       done ;;
  esac
}

cmd_close() {
  local n="$1"
  gh issue close "$n" --repo "$REPO"
  echo "Closed #$n."
}

case "${1:-list}" in
  list) cmd_list ;;
  show) [ $# -ge 2 ] || { echo "usage: bug-triage.sh show <issue-number>"; exit 2; }; cmd_show "$2" ;;
  pick) cmd_pick ;;
  close) [ $# -ge 2 ] || { echo "usage: bug-triage.sh close <issue-number>"; exit 2; }; cmd_close "$2" ;;
  *) echo "usage: bug-triage.sh [list|show <n>|pick|close <n>]"; exit 2 ;;
esac
