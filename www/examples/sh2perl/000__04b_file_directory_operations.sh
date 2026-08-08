#!/bin/bash

echo "=== File and Directory Operations ==="
d=$(mktemp -d)
cd "$d" || exit 1
printf 'a\n' > a.sh
printf 'b\n' > b.txt
mkdir sub
printf 'c\n' > sub/c.sh
printf 'x\n' > .hidden

file_list=`ls -A`
echo "File listing:"
echo "$file_list"

found_files=`find . -name "*.sh" -type f`
echo "Found shell scripts:"
echo "$found_files"

cd /
rm -rf "$d"
echo "=== File and Directory Operations Complete ==="
