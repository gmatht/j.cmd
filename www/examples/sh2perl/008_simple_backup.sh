#!/bin/bash

# Simple shell script example
echo "Hello, World!"
# Run in a private scratch dir so `ls` output is deterministic
d=$(mktemp -d)
mkdir -p "$d/sub1" "$d/sub2"
touch "$d/a.txt" "$d/b.txt"
cd "$d"
#TODO: Support multi-column output
#This should be a single token, not two.
#AST_MUST_CONTAIN: [Literal("-1")]
ls -1 | grep -v a.txt
echo `ls | grep -v a.txt`
#Lets not consider ls -la at the moment as permissions are OS dependent
#ls -la
cd /
rm -rf "$d"
