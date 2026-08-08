#!/bin/bash
# Demonstrates a multi-line spurious SQS caused by logos treating a closing
# ' as the opening of a new single-quoted string that spans multiple lines.
# The key is: awk '{print $1}' inside $() where the closing ' of the awk
# script is followed by )\ndo (newline + shell keyword).
for f in $(cmd | awk '{print $1}')
do
  echo "$f"
done
