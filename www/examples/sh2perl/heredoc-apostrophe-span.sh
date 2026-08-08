#!/bin/bash
# Heredoc with apostrophe that creates a spanning string
result=$(cat << EOF
It's a test with an apostrophe here.
EOF
)
printf 'heredoc content=[%s]\n' "$result"
