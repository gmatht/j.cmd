#!/bin/bash

# Until loop
count=3
until [ "$count" -eq 0 ]; do
    echo "count=$count"
    count=$(( count - 1 ))
done
