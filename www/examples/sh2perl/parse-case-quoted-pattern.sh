#!/bin/sh
# Case pattern with single-quoted strings containing newlines and special chars.
# Tests that the parser correctly handles multi-line single-quoted patterns
# inside case statements, especially when nested inside $().
case $i in
(*'
'* | *'&'* | *'\'* | *'|'*)
    echo "match"
    ;;
esac
