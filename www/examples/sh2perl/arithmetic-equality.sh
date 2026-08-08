#!/bin/sh
# Regression test: == inside ((...)) arithmetic must be handled.
# The Equality token must be recognized in arithmetic expressions.
n=5
if (( $n == 5 )); then
  echo "equal"
fi
printf "%s=[%s]\n" n "${n:-}"

