#!/bin/sh
# Multi-line single-quoted awk script containing shell-like keywords
# Tests that split_overgreedy_sq does NOT split legitimate multi-line strings
echo "data" | awk '
BEGIN { count = 0 }
{
  if ($1 ~ /test/) {
    count++
  } else {
    print $0
  }
}
END { print count }
'
