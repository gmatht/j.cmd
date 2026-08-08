#!/bin/sh
# Heredoc with subshell and redirects on same line
# sh2perl fails with "Unexpected end of input"
( echo test ) <<EOF 2>&1 >/dev/null
first line
second line
EOF
echo "after"

echo "done: $?"
