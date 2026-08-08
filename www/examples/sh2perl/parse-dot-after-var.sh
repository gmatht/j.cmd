#!/bin/bash
# $DEST.new should be parsed as $DEST concatenated with .new
DEST="/path/to/file"
if ! command <$DEST.new >$DEST.neww; then
    echo "failed"
fi
printf "%s=[%s]\n" DEST "${DEST:-}"

