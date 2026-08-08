#!/bin/bash
# @ in test expressions
if [[ "$0" = @(pattern) ]]; then
    true
fi
printf "parsed OK\\n"
