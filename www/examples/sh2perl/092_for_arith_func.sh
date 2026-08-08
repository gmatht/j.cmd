#!/bin/bash

# For loop with function and arithmetic
factorial() {
    local n=$1
    local result=1
    local i
    for (( i = 2; i <= n; i++ )); do
        result=$(( result * i ))
    done
    echo "$result"
}
factorial 5
factorial 6
