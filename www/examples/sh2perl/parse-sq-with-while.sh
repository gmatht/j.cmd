#!/bin/sh
# Multi-line single-quoted string containing 'while' keyword
# The keyword 'while' has more content after it on the same line,
# so split_overgreedy_sq should NOT split here.
echo | awk '
BEGIN {
  while (getline < "/dev/null") {
    print "loop"
  }
}
'

result="ok"
echo "status: ${result}"
