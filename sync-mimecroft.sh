#!/usr/bin/env bash
# ─── sync-mimecroft.sh — keep the mimecroft copies in lockstep ──
# examples/mimecroft.sh is the canonical source (the test harness reads
# it); www/bin/mimecroft.sh is the staged command template the shell
# materializes into /bin on first use. The vertex shader follows the
# same pattern: examples/mimecroft-vertex.sh is canonical →
# www/bin/mimecroft-vertex-shader.sh (the staged /bin copy) and
# www/examples/mimecroft-vertex.sh (the /examples mount the game reads
# at runtime). The sound-effect generators (examples/sounds/*.sh — the
# sample-accurate companions the game's --sounds bash mode runs) are
# staged to www/examples/sounds/ with a fresh index.json so
# /examples/sounds is served in the browser shell. Edit the canonical
# files, then run this to refresh.
set -e
cd "$(dirname "$0")"
cp examples/mimecroft.sh www/bin/mimecroft.sh
cp examples/mimecroft-vertex.sh www/bin/mimecroft-vertex-shader.sh
cp examples/mimecroft-vertex.sh www/examples/mimecroft-vertex.sh
cp examples/mimecroft-frag.sh www/examples/mimecroft-frag.sh
cp examples/mimecroft-vertex.glsl www/examples/mimecroft-vertex.glsl
cp examples/mimecroft-frag.glsl www/examples/mimecroft-frag.glsl
diff -q examples/mimecroft.sh www/bin/mimecroft.sh
diff -q examples/mimecroft-vertex.sh www/bin/mimecroft-vertex-shader.sh
diff -q examples/mimecroft-vertex.sh www/examples/mimecroft-vertex.sh
diff -q examples/mimecroft-frag.sh www/examples/mimecroft-frag.sh
diff -q examples/mimecroft-vertex.glsl www/examples/mimecroft-vertex.glsl
diff -q examples/mimecroft-frag.glsl www/examples/mimecroft-frag.glsl
# sounds: the whole directory (scripts + lib + README + batch tools)
rm -rf www/examples/sounds
mkdir -p www/examples/sounds
cp examples/sounds/*.sh examples/sounds/README.md www/examples/sounds/
ls www/examples/sounds/*.sh www/examples/sounds/README.md \
  | sed 's#www/examples/sounds/##' \
  | sort \
  | python3 -c 'import sys, json; print(json.dumps([l.strip() for l in sys.stdin]))' \
  > www/examples/sounds/index.json
diff -q examples/sounds/sound-lib.sh www/examples/sounds/sound-lib.sh
echo "mimecroft.sh + mimecroft-vertex.sh + examples/sounds staged copies refreshed"
