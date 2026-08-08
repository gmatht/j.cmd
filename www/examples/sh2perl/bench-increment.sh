#!/bin/sh
# shellbench count:increment — ((i++)) arithmetic per iteration
i=1
__n=0
while [ $__n -lt 1000 ]; do
  ((i++))
  __n=$((__n+1))
done
echo "increment=$i"
