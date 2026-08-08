#!/bin/sh
# $? inside a test expression
# Parse error: "Unexpected token: Question"
true
if [ $? -eq 0 ]; then
  echo "ok"
fi
