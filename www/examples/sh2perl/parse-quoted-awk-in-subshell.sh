#!/bin/bash
# Single-quoted awk script inside $(...) command substitution.
# The closing ' after the awk body triggers the logos bug.
RESULT=$(echo "test" | awk '{print $1}')
echo $RESULT
