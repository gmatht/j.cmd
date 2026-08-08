#!/bin/sh
# shellbench stringop4 builtin — pattern substitution
s=abc:def:ghi
echo "all=${s//:/,}"
echo "front=${s/abc/XYZ}"
echo "back=${s/ghi/XYZ}"
