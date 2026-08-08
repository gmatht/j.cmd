#!/bin/sh
# Backslash continuation inside $() inside double quotes
# Parse error: "Unexpected token: ParenClose"
result="$(echo hello \
  && echo world)"
echo "$result"
