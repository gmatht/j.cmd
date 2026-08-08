#!/bin/sh
# Test that a single-quoted variable assignment containing the '\''
# idiom (embedded single quote) is parsed correctly.
escape='
  s/'\''/'\''\\'\'''\''/g
'
echo "${escape}"
