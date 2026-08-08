#!/bin/bash

# If condition with file test and pipeline
if [ -f /etc/passwd ]; then
    cat /etc/passwd | head -3 | cut -d: -f1
else
    echo "not found"
fi

echo "exit: $?"
