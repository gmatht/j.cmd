#!/bin/sh
# $@ with default value: ${@:-"default"}
# Parse error: "Lexer error: Unexpected character: ?"
ARGS=${@:-"default"}
echo "$ARGS"
