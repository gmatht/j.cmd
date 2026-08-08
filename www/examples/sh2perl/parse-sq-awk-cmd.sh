#!/bin/sh
# Multi-line single-quoted awk script (common pattern from failing files)
# The single quotes enclose an awk program that contains shell-like keywords
echo "$HOME" | awk '
{
  if ($1 ~ /test/) {
    print "match"
  } else {
    print "no match"
  }
}
'
