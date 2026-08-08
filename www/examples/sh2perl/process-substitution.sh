#!/bin/bash
# Test: process substitution <(cmd) should parse or fallback gracefully.
diff <(echo one) <(echo two)

echo "exit: $?"
