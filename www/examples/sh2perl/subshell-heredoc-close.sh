#!/bin/sh
# Subshell with heredoc followed by closing paren
var=hello
(
  cat <<EOF
content
EOF
)
eval "$var"
printf 'var after eval=[%s]\n' "$var"
