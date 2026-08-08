#!/bin/sh
# Test: path containing 'system' should not trigger check_qx false positive
if [ -d /run/systemd/system ]; then
    echo "systemd"
fi

echo "exit: $?"
