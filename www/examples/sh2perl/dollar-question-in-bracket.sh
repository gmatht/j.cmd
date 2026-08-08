#!/bin/sh
# $? in a test expression inside a command substitution
# Parse error: "Unexpected token: Question"
LIBSSL=$(dpkg-query -f '${db:Status-Abbrev}' -W 'libssl1.0.?' 2>&1)
if [ $? -eq 2 ]; then
printf 'LIBSSL=[%s]\n' "$LIBSSL"
    echo "error"
fi
