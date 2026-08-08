#!/bin/sh
# Test sed with escaped parens inside $(...) in double-quoted string
x="$(echo foo | sed 's|foo|bar|')"
echo "$x"
