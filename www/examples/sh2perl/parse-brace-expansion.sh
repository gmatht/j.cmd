#!/bin/sh
# Brace expansion in echo - can cause parse errors
echo {1..5}

echo "exit: $?"
