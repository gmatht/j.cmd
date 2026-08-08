#!/bin/sh
# shellbench stringop2 echo|cut — the spawn pipeline's result
s=abc:def:ghi
echo "$s" | cut -d: -f1
echo "$s" | cut -d: -f2-3
