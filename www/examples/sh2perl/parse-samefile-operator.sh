#!/bin/sh
# The -ef test operator was not handled in parse_word
test "$A" -ef "$B" 2>/dev/null && echo "same file"
