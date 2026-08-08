#!/bin/bash

# 15. Complex function definition with local variables and arithmetic
complex_func() {
    local x="$1"
    local y="$2"
    local result=$(( x + y ))
    echo "Sum: $result"
    echo "Args: $x $y"
}

# Test the function
complex_func 3 7
complex_func 10 20
