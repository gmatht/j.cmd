#!/bin/bash
# ${var#pattern} inside $(...) - # starts a line comment in lexer
# but it's actually a parameter expansion operator.
result=$(echo ${0#/})
echo "$result"
