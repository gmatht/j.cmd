#!/bin/sh
# cat heredoc in subshell pipeline - generates sh -c 'cat'
(
    cat <<EOF
hello world
EOF
) | wc -l

echo "exit: $?"
