#!/bin/sh
# Regression test: ${var%pattern} and ${var#pattern} parameter expansions.
# The % and # tokens must be recognized inside ${}.
A="${B%%.*}"
C="${D#*_}"
echo "$A $C"
