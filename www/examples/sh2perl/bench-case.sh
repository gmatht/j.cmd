#!/bin/sh
# shellbench cmp:case — case dispatch
x=hello
case $x in
  *llo) echo "case=match" ;;
  *)    echo "case=no" ;;
esac
y=abc
case $y in
  *llo) echo "case2=match" ;;
  *)    echo "case2=no" ;;
esac
