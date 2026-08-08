#!/bin/sh
# Test: complex arithmetic with parentheses
# Nested arithmetic expressions
a=$(( (1 + 2) * 3 ))
b=$(( ( (1 + 2) * 3 ) / 2 ))
c=$(( a + b ))
printf 'a=[%s]\n' "$a"
printf 'b=[%s]\n' "$b"
printf 'c=[%s]\n' "$c"
echo "$(( a + b + c ))"
