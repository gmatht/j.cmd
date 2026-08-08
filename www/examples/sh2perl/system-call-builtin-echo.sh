#!/bin/sh
# Test: Generated Perl should not use system('/bin/echo', ...)
# which triggers check_qx.pl Pattern 3 (system with builtin 'echo').
# Instead use native Perl print.
echo "hello world"

echo "done: $?"
