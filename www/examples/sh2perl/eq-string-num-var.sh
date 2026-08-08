#!/bin/bash
# string-equality tests against NUMERIC-lifted vars: bash `=` compares the
# STRING expansions — a bare JS `===` (number vs string) would always fail
for i in 1 2 3; do
    [ "$i" = "2" ] && echo "hit=$i"
done
[ "$?" = "0" ] && echo "status-zero"
true
[ "$?" = "0" ] && echo "status-zero2"
