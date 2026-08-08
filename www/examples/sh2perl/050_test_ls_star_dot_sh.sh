#!/usr/bin/env bash
set -euo pipefail
# Hermetic: `ls * .sh` must not glob the shared workspace root (whose
# contents change during full runs, and a stray `.sh` file flips the
# set -e abort). Run in a fixed tempdir with known files.
d=$(mktemp -d)
cd "$d" || exit 1
touch a.sh b.sh .sh
echo "Testing ls * .sh:"
ls * .sh
echo "exit: $?"
cd /; rm -rf "$d"
