#!/bin/bash
# Test: here-string <<< should not crash the parser.
grep -q hello <<< "hello world"

echo "exit: $?"
