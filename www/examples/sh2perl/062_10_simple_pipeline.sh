#!/bin/bash

# 10. Simple pipeline without complex redirections
echo "Testing simple pipeline..."
d=$(mktemp -d)
mkdir -p "$d/dir1" "$d/dir2" "$d/dir3"
touch "$d/file1" "$d/file2"
cd "$d"
ls -l | grep "^d" | head -5

echo "exit: $?"
cd /
rm -rf "$d"
