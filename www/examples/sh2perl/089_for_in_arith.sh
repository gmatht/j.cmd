#!/bin/bash

# For loop with arithmetic
total=0
for i in 1 2 3 4 5; do
    total=$(( total + i ))
done
echo "total=$total"
