#!/bin/sh
# sed in backtick command substitution - generates open3 with builtin 'sed'
RESULT=$(sed -n '1p' somefile)
echo "$RESULT"
