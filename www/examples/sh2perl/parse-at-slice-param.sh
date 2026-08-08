#!/bin/sh
# ${@:3} parameter expansion with slice
set -- "$1" "$tempfile" "${@:3}"
echo "${@:1}"
