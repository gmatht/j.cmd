#!/bin/bash
# Regression test: Python f-strings (f'...{var}...') inside a heredoc
# cause logos to tokenize the first inner quote as closing the
# SingleQuotedString, leaving a trailing orphan quote that spans
# past the EOF delimiter and corrupts post-heredoc tokens.
result=$(cat << 'EOF'
import re
name = "world"
print(f'Hello, {name}!')
EOF
)
printf 'heredoc content=[%s]\n' "$result"
