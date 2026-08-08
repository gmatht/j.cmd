#!/bin/sh
# Semicolon inside a test expression - should be valid
if [ -f "$file" ]; then
  echo "exists"
fi
