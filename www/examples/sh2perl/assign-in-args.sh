#!/bin/bash
# '=' as argument to test command
test "foo" = "bar"
# '=' as argument to other commands
echo "a=b" | sed 's/=/:/'

echo "exit: $?"
