#!/bin/sh
# $@ with default value containing quotes: ${@:-""}
# sh2perl generation (parse error)
ARGS=${@:-""}
echo "$ARGS"
