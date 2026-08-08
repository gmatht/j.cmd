#!/bin/bash

# Pipeline examples
ls | grep "\.txt$" | wc -l
echo
cat file.txt | sort | uniq -c | sort -nr
echo
find . -name "*.sh" | xargs grep -l "function"  | tr -d "\\\\/"
echo
# This pipeline will use line-by-line processing:
cat file.txt | tr 'a' 'b' | grep 'hello'
echo
# This pipeline will fall back to buffered processing:
cat file.txt | sort | grep 'hello'