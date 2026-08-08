#!/bin/sh
# Run in a private scratch dir so the resolved path is deterministic
d=$(mktemp -d)
mkdir -p "$d/a"
cd "$d/a" || exit 1
cd ..
printf 'parent contains a: %s\n' "$(test -d a && echo yes || echo no)"
cd /
rm -rf "$d"
