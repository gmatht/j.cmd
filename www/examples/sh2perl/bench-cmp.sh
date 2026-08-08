#!/bin/sh
# shellbench cmp — [ ] comparisons (observable via $?)
[ "abc" = "abc" ]; echo "eq=$?"
[ "abc" != "xyz" ]; echo "ne=$?"
[ 5 -lt 10 ]; echo "lt=$?"
