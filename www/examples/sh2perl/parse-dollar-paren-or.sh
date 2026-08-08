#!/bin/sh
# Nested $() with || {} after the closing parenthesis.
# The capture_parenthetical_text function must correctly track
# parenthesis depth through the nested $() and its || {} suffix.
r=$(
    echo "hello"
) || {
    x=$?
}
echo "$r"
printf "%s=[%s]\n" x "${x:-}"

