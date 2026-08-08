#!/bin/sh
# Parse error: Unexpected end of input (heredoc related)
cat <<EOF
hello world
EOF

echo "exit: $?"
