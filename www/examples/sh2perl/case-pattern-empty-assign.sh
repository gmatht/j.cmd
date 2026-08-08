#!/bin/sh
# Case pattern with empty assignment before ;;
case "$x" in
  a) y=;;
  *) z=;;
esac
printf "parsed OK\\n"
