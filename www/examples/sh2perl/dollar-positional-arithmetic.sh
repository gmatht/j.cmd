#!/bin/bash
# $N (positional parameter) inside arithmetic expression
n=$(($1 + 0)) 2>/dev/null && test "$n" = "$1"
printf "%s=[%s]\n" n "${n:-}"

