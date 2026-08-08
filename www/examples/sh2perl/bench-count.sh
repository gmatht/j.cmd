#!/bin/sh
# shellbench count:posix — the loop's accumulated value is the observable result
i=1
__n=0
while [ $__n -lt 1000 ]; do
  i=$((i+1))
  __n=$((__n+1))
done
echo "count=$i"
