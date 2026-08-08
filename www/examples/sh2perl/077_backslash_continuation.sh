#!/bin/bash

# Backslash line continuation in a pipeline
echo "hello" \
    | tr a-z A-Z

echo "exit: $?"
