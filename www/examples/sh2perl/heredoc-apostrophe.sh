#!/bin/sh
# Heredoc with apostrophes in body
result=$(cat << 'EOF'
This is a test with an apostrophe: it's fine
EOF
)
printf 'heredoc content=[%s]\n' "$result"
