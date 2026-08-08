#!/bin/sh
# Nested subshells with file descriptor redirects
result=$(
    (
        gzip -cdfq -- "$file1" 4>&- 
        echo $? >&4
    ) 3>&- 5<&- </dev/null |
    eval "$cmp" /dev/fd/5 - >&3
)
echo "$result"
