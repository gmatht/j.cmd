#!/bin/bash

# Function with command substitution and pipeline
upper() {
    local val
    val=$(echo "$1" | tr a-z A-Z)
    echo "$val"
}
upper "hello"
upper "world"
