#!/bin/sh
# Parse error: '||' continuation to next line (identifier after operator)
cd /nonexistent/path ||
echo "fallback"

echo "exit: $?"
