#!/bin/bash
# Demonstrates a single-line spurious SQS: the ' that closes one awk script
# is treated as the opening of a new SQS that contains shell operators.
# Pattern: cmd | awk '{print$3}' | sed '...'
result=$(echo "test" | awk '{print$3}' | sed 's|\(.*\)/.*|\1|')
echo "$result"
