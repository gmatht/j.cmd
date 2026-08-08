#!/bin/bash
# Tests | inside test expressions (used in regex)
if [[ $release =~ bullseye|bookworm|jammy ]]; then
    echo "match"
fi
