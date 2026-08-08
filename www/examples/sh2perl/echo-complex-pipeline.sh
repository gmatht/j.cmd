#!/bin/sh
# echo in complex pipeline - generates bash -c wrapping builtin 'echo'
result=$(echo "test" | tr a-z A-Z)
echo "$result"
