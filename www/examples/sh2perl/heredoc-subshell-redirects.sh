#!/bin/sh
# Heredoc inside subshell with redirects on same line
var=test
( eval "$var" ) <<EOF 2>&1 >/dev/null
the body
EOF
printf 'heredoc+subshell+redirect ran OK\n'
printf "%s=[%s]\n" var "${var:-}"

