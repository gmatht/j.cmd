#!/bin/sh
# This is an 'example' with single quotes in a comment
# sh2perl fails: Unexpected token: SingleQuote at comment line
printf 'parsed single-quotes in comments OK\n'

echo "done: $?"
