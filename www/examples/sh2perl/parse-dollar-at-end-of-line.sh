#!/bin/sh
# Test: $ at end of line (no variable name follows)
# This is valid in bash - $ is just a literal $ when at end of line
echo "the price is $"
x=$
echo "$x"
