#!/bin/sh
# Complex command substitution with subshells and redirects
set -- file1 file2
result=$(
  (gzip -cdfq -- "$1" 4>&-; echo $? >&4) 3>&- |
    (gzip -cdfq -- "$2" 4>&-; echo $? >&4) 3>&- 5<&- </dev/null
)
printf 'result=%s\n' "${result:-empty}"
