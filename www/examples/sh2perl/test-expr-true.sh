#!/bin/bash
# Tests 'true' keyword inside test expressions
if [[ "$var" == true ]]; then
    echo "it's true"
fi
