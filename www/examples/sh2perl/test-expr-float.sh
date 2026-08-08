#!/bin/bash
# Tests float tokens (like 5.4) in test expressions
if [[ $(uname -r) == 5.4.* ]]; then
    echo "match"
fi
