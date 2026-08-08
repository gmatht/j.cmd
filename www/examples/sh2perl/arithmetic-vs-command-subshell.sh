#!/bin/sh
# $(( ambiguous - could be arithmetic or command subshell
result=$((echo "test"))
printf 'result=%s\n' "${result:-empty}"
