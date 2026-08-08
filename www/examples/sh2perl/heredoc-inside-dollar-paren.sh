#!/bin/sh
# Heredoc inside $(...) command substitution
x=$(cat <<EOF
line1
line2
EOF
)
printf 'result=[%s]\n' "$x"
