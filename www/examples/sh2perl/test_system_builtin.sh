#!/bin/bash

echo "Testing system calls with builtin commands"
d=$(mktemp -d)
cd "$d" || exit 1
printf 'a\n' > a.txt
printf 'b\n' > b.txt
mkdir sub
printf 'c\n' > sub/c.txt

result1=`ls -A`
result2=`find . -name "*.txt"`

echo "Results:"
echo "$result1"
echo "$result2"
cd /
rm -rf "$d"
