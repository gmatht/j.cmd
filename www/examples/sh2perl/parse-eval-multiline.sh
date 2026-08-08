#!/bin/sh
# Multi-line eval with single-quoted string.
# This pattern (using eval with a multi-line single-quoted script)
# appears in tzselect and other shell scripts.
eval '
    doselect() {
        select select_result; do
            case $select_result in
                "") echo >&2 "Please enter a number." ;;
                ?*) break ;;
            esac
        done
    }
'
# Verify function was defined
type doselect 2>/dev/null | head -1
printf 'doselect definition parsed OK\n'
