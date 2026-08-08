#!/bin/bash
# Heredoc with apostrophe in unquoted delimiter creates spanning string
result=$(cat << EOF
This is a test with an apostrophe: it's here.
EOF
)
printf 'heredoc content=[%s]\n' "$result"
