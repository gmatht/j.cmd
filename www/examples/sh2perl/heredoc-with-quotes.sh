#!/bin/sh
# Regression test: heredoc containing single quotes, which must not
# confuse the lexer into opening a false string.
result=$(cat <<'EOF'
I can't stop this feeling
EOF
)
printf 'heredoc content=[%s]\n' "$result"
