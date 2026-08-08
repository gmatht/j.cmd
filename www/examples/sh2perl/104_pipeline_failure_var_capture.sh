#!/bin/bash
# Variable capture from pipeline
d=$(mktemp -d)
files=$(ls "$d" 2>/dev/null | wc -l)
echo "Files: $files"
count=$(echo "a b c" | wc -w)
echo "Words: $count"
cd /
rm -rf "$d"
echo "done"
