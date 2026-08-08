#!/bin/sh
# ${@:3} parameter expansion
set -- a b c d
echo "${@:3}"
