#!/bin/sh
# Tests backtick command substitution in test expression
if [ "$(echo hello)" = "hello" ]; then
    echo "match"
fi
