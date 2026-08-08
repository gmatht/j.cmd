#!/bin/sh
# for loop with $@ and complex if/pipe inside
# Parse error: "Lexer error: Unexpected character: ?"
X_SET=0
for arg in $@; do
    if echo "$arg" | grep -q -e '^-[a-zA-Z0-9]*x'; then
         X_SET=1
    fi
done
echo "$X_SET"
