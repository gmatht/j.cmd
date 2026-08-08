#!/bin/sh
# Multi-line single-quoted awk script with 'while' keyword on its own line
# Tests that split_overgreedy_sq does NOT split at 'while' when it has content after it
echo "test data" | awk '
{
  while (getline < "/dev/null") {
    print "looping"
  }
}
' > /dev/null

result="ok"
echo "status: ${result}"
