#!/bin/sh
# Test bracket expressions
if [ -f "$file" ] && [ -r "$file" ]; then
  echo readable
fi
