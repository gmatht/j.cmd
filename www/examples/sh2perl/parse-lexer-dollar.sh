#!/bin/sh
# Test: lexer error on unexpected $ character
# $ followed by certain characters can confuse the lexer
echo $'\n'
echo $'hello\tworld'
