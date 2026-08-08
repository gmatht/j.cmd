#!/bin/sh
# Test: tab-indented heredoc (<<-EOF) must parse correctly.
cat <<-EOF
	hello world
EOF

echo "exit: $?"
