#!/bin/sh
# Test: source command in test expressions
# source can be used in various ways
if [ -f /etc/config ]; then
    . /etc/config
    source /etc/profile
fi

echo "exit: $?"
