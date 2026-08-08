#!/bin/sh
# Minimal reproduction of heredoc followed by parenthesis causing ParenClose parse error
# Similar to config.sub failure
cat <<EOF
$1
EOF
IFS='
'
printf "%s=[%s]\n" IFS "${IFS:-}"

