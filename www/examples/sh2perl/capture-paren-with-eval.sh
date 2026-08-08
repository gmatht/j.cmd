#!/bin/sh
# Test: $((( expr )) ) where the outer $( contains a nested (( arithmetic
# expression.  The capture_parenthetical_text function must correctly track
# the extra opening parens from (( and the extra closing from )).
result=$((( 1 + 2 )))
echo "$result"
