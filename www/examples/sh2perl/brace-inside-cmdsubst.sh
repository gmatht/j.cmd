#!/bin/bash
# Demonstrates brace expansion parsing failure inside command substitution.
# The {print ...} inside awk is inside $().
result=$(echo "hello" | awk '{print $1}')
echo "$result"
