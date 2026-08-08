#!/bin/bash

# 6. Complex pipeline with background processes and subshells
(sleep 1; echo "Starting") &
(sleep 2; echo "Processing") &
wait
echo "All done"

echo "exit: $?"
