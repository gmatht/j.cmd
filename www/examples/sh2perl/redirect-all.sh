#!/bin/bash
# Redirect all (&> /dev/null) in if condition
if ! command -v nonexistent &> /dev/null; then
    echo "not found"
fi

echo "exit: $?"
