#!/bin/bash
# Regression test: ps command in system() context
# ps is commonly used to check running processes
if ps -C apt-get,apt,dpkg > /dev/null 2>&1; then
    echo "Package manager running"
fi

echo "done: $?"
