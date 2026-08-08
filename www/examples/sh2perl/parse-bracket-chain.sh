#!/bin/sh
# Tests parsing of chained test expressions with && in if conditions
# This pattern triggers "Unexpected token in test expression: Semicolon"
if [ -z "$VAR1" ] && [ -z "$VAR2" ]; then
    echo "Both empty"
fi
