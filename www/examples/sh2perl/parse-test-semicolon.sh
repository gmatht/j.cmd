#!/bin/sh
# Test: semicolon inside test expression
# Some scripts use [ ... ; ... ] which is invalid but should not crash
# Actually this is a syntax error, but let's test valid semicolons in tests
if [ -n "$var" ]; then
    echo "var is set"
fi
[ -f "$file" ] && echo "file exists"
