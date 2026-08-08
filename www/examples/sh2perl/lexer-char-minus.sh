#!/bin/sh
# Lexer error: unexpected character '-'
# This tests patterns that might confuse the lexer with '-' characters
set -e
export LANG=C
test "a" = "b"
printf "parsed OK\\n"

echo "done: $?"
