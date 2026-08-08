#!/bin/sh
# Variable concatenated with single-quoted string
x=hello
y=$x'world'
echo $y
printf "%s=[%s]\n" x "${x:-}"

