#!/bin/bash
# $1 positional parameter inside $((...)) arithmetic expansion
isnumber() {
    n=$(($1 + 0)) 2>/dev/null && test "$n" = "$1"
}
echo $(($1 * 100 + $2))
printf "%s=[%s]\n" n "${n:-}"

