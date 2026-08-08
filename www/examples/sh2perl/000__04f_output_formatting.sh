#!/bin/bash

# Output and formatting commands using backticks
# This file demonstrates output and formatting commands with backticks

echo "=== Output and Formatting Commands ==="

# echo command with backticks
#PERL_MUST_NOT_CONTAIN `echo
echo_result=`echo "Hello from backticks"`
echo "Echo result: $echo_result"

# printf command with backticks
#PERL_MUST_NOT_CONTAIN `printf
d=$(mktemp -d)
cd "$d" || exit 1
printf_result=`printf "Number: %d, String: %s\n" 42 "test"`
echo "Printf result: $printf_result"

# tee command with backticks
#PERL_MUST_NOT_CONTAIN `tee
tee_result=`echo "test output" | tee test_tee.txt`
echo "Tee result: $tee_result"

# Cleanup
rm -f test_tee.txt

echo "=== Output and Formatting Commands Complete ==="
cd /
rm -rf "$d"

