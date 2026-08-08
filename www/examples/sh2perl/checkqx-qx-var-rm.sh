#!/bin/sh
# Minimal test: rm command with unknown option triggers shell fallback.
rm --preserve-root testfile
printf "parsed OK\\n"

echo "exit: $?"
