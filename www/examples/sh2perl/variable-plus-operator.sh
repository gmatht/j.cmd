#!/bin/sh
# ${var+value} parameter expansion (without colon)
# Used for checking if a variable is set
if test -n "${MYVAR+set}"; then
  echo "MYVAR is set"
fi
