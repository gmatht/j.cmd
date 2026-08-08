#!/bin/sh
# (( used for nested subshell (cmd1) | cmd2 ) not arithmetic
result=$(
    ((gzip -cdfq -- "$file1" 4>&-
      echo $? >&4) 3>&- </dev/null |
     eval cmp /dev/fd/5 - >&3)
)
echo "$result"
