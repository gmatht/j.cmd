#!/bin/sh
# Dangling || after heredoc (no right operand)
f=out.txt
cat >"$f" <<EOF ||
content
EOF
printf 'wrote %d bytes to %s\n' $(wc -c < "$f") "$f"
