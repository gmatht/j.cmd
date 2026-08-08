#!/bin/sh
# Regression: ? glob characters in rm argument
f=/var/lib/foo
if [ -d "$f" ]; then
    rm -f "$f"/??\:??\:??
fi
printf "%s=[%s]\n" f "${f:-}"

