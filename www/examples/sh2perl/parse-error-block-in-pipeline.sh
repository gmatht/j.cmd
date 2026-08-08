#!/bin/sh
# Brace group in a pipeline/while condition should be parsed as block
while ! { : >> /tmp/parse_error_block_test; } 2>/dev/null; do
  echo "waiting"
done

echo "exit: $?"
