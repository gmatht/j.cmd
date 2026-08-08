#!/bin/bash
# $VAR.suffix is variable followed by literal
if ! command <$DEST.new >$DEST.neww; then
    echo failed
fi
