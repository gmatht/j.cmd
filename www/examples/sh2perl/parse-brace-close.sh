#!/bin/sh
# Test: unmatched/confusing brace sequences
# Brace expansion mixed with other syntax
echo {1..5}
echo file{.txt,.bak}
for i in {1..3}; do
    echo "$i"
done
