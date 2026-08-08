#!/bin/bash
# Escaped > in test expression (string comparison)
a=5
b=10
if [ "$a" \> "$b" ]; then
    echo "a > b"
fi
printf "%s=[%s]\n" a "${a:-}"
printf "%s=[%s]\n" b "${b:-}"

