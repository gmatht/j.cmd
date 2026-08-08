#!/bin/bash
# Tests $() command substitution inside [[ ]]
if [[ $(uname -r) == 5.4.* ]]; then
    echo "match"
fi
