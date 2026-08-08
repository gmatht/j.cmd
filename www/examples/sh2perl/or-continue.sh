#!/bin/bash
# '|| continue' inside for loop
for i in 1 2 3; do
    [ "$i" = "2" ] || continue
    echo "$i"
done
