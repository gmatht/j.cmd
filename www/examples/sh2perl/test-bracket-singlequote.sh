#!/bin/sh
# Regression test: printf with [ inside single-quoted string.
# The [ must NOT be tokenized as TestBracket.
printf '%s [Y/n] %s\n' "a" "b"

echo "exit: $?"
