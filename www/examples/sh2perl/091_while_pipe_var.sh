#!/bin/bash

# While loop with pipe and variable modification
count=0
while read -r line; do
    count=$(( count + 1 ))
    echo "$count: $line"
done < /etc/passwd | head -3
