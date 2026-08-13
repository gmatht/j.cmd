#!/usr/bin/env bash
# ─── sync-mimecroft.sh — keep the mimecroft copies in lockstep ──
# examples/mimecroft.sh is the canonical source (the test harness reads
# it); www/bin/mimecroft.sh is the staged command template the shell
# materializes into /bin on first use. The vertex shader follows the
# same pattern: examples/mimecroft-vertex.sh is canonical →
# www/bin/mimecroft-vertex-shader.sh (the staged /bin copy) and
# www/examples/mimecroft-vertex.sh (the /examples mount the game reads
# at runtime). Edit the canonical files, then run this to refresh.
set -e
cd "$(dirname "$0")"
cp examples/mimecroft.sh www/bin/mimecroft.sh
cp examples/mimecroft-vertex.sh www/bin/mimecroft-vertex-shader.sh
cp examples/mimecroft-vertex.sh www/examples/mimecroft-vertex.sh
diff -q examples/mimecroft.sh www/bin/mimecroft.sh
diff -q examples/mimecroft-vertex.sh www/bin/mimecroft-vertex-shader.sh
diff -q examples/mimecroft-vertex.sh www/examples/mimecroft-vertex.sh
echo "mimecroft.sh + mimecroft-vertex.sh staged copies refreshed"
