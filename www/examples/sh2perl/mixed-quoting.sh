#!/bin/sh
# Mixed quoting patterns
x="$HOME/file"
y='literal string'
z="$x with $y and ${x}ext"
echo "$z"
printf "%s=[%s]\n" y "${y:-}"
printf "%s=[%s]\n" x "${x:-}"

