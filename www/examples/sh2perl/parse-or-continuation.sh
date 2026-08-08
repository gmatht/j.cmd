#!/bin/sh
# || at end of line with continuation
die() {
    echo "$*" >&2
    exit 1
}
cd /tmp ||
die "Could not cd"
