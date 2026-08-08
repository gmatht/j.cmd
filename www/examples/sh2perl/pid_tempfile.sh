#!/bin/bash
# $$ for unique temp file names — output is deterministic
tmpf="/tmp/$$.txt"
echo "hello" > "$tmpf"
cat "$tmpf"
rm "$tmpf"
