#!/bin/bash
# Minimal reproduction of escaped parentheses in $(...) command substitution
# Similar to get_next_oid failure (now fixed)
x=$(grep 'foo\(bar' /dev/null)
printf "%s=[%s]\n" x "${x:-}"

