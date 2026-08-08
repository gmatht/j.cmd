#!/bin/bash
# Question mark inside single-quoted string in command substitution
# Used inside a variable assignment
LIBSSL=$(dpkg-query -W 'libssl1.0.?' 2>&1)
echo "$LIBSSL"
