#!/bin/sh
# Test: unexpected ) (ParenClose) outside any subshell
# Nested arithmetic can sometimes confuse the parser
echo "hello"
)
# This ) above is outside any subshell

echo "exit: $?"
