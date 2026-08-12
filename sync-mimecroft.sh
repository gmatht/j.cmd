#!/usr/bin/env bash
# ─── sync-mimecroft.sh — keep the two mimecroft.sh copies in lockstep ──
# examples/mimecroft.sh is the canonical source (the test harness reads
# it); www/bin/mimecroft.sh is the staged command template the shell
# materializes into /bin on first use. Edit the canonical file, then run
# this to refresh the staged copy.
set -e
cd "$(dirname "$0")"
cp examples/mimecroft.sh www/bin/mimecroft.sh
diff -q examples/mimecroft.sh www/bin/mimecroft.sh
echo "mimecroft.sh staged copy refreshed"
