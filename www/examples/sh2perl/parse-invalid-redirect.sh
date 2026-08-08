#!/bin/sh
# Parse error: Invalid redirect operator
exec 3>&1
echo "test" >&3

echo "exit: $?"
