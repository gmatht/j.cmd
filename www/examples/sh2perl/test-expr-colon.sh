#!/bin/bash
# Tests colon in test expression (e.g., regex matching with =~)
if [[ "$line" =~ DEBUG: ]]; then
    echo "match"
fi
