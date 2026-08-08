#!/bin/sh
# Heredoc inside a function with <<- delimiter
show_help () {
  cat <<-EOF
	Usage: script [options]
	EOF
}
show_help

echo "exit: $?"
