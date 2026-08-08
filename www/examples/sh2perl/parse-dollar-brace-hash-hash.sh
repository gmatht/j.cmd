#!/bin/sh
# Parameter expansion with ## (remove longest prefix pattern)
# inside a [[ ... ]] test expression.
# The ${0##*/} pattern extracts the basename of the script path.
if [[ "${0##*/}" == "myscript" ]]; then
    echo "run as myscript"
fi
