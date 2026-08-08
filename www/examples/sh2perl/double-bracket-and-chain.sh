#!/bin/bash
# Double-bracket [[ ... ]] with command substitution and && chain
# Tests the parser's handling of [[ ... ]] && command
if [[ -n $(echo "test" | grep test) ]] && command -v ls >/dev/null; then
    echo "found"
fi
