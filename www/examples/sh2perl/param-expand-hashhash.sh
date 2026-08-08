#!/bin/sh
# Test that ${0##*/} (parameter expansion with ## pattern removal)
# is parsed correctly.  The ## creates a Comment token in the lexer
# that must be properly handled inside ${...}.
cmd=${0##*/}
exec echo "$cmd"
