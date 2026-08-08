#!/bin/sh
# Backslash continuation inside $() command substitution.
# The lexer removes backslash-newline pairs, so the parser
# must handle the concatenated content correctly.
x="$(
    echo "hello" \
        "world"
)"
echo "$x"
