#!/bin/sh
# Multi-line single-quoted string assigned to a variable.
# This was failing because the parser didn't handle bare SingleQuote
# tokens that result from lexer's split_overgreedy_sq or fix_bare_quotes.
var='
multi-line
value
'
echo "$var"
