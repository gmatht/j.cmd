#!/bin/sh
# shellbench stringop3 builtin — pattern removal
s=abc:def:ghi
echo "short-prefix=${s#*:}"
echo "long-prefix=${s##*:}"
echo "short-suffix=${s%:*}"
echo "long-suffix=${s%%:*}"
