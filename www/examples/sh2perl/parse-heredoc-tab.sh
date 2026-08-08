#!/bin/sh
# Test: heredoc with tabs <<-
result=$(cat <<-EOF
	indented content
	with tabs
EOF
)
printf 'heredoc content=[%s]\n' "$result"
