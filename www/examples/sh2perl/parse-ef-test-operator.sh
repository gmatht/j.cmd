#!/bin/sh
# Test: '-ef' test operator inside `test` (not [[ ]]) must not confuse the lexer.
# -ef is tokenized as SameFile which is fine inside [[ ]] but needs handling in `test`.
if test "$A" -ef "$B" 2>/dev/null; then
  echo "same file"
fi
