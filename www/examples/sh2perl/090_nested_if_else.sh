#!/bin/bash

# Nested if-else with string comparison
x="hello"
if [ "$x" = "hello" ]; then
    echo "greeting"
elif [ "$x" = "bye" ]; then
    echo "farewell"
else
    echo "unknown"
fi
