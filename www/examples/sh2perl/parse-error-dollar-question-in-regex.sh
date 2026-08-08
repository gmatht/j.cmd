#!/bin/sh
# $? in a regex pattern inside backtick substitution should not confuse parser
cmd="`grep -E "^Exec(\[[^]=]*])?=" "$file"`"
echo "$cmd"
