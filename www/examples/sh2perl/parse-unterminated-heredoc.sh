#!/bin/sh
# Test: unterminated heredoc (EOF marker never reached)
# This is intentionally missing the closing EOF marker to test error recovery
cat << EOF
hello world
this line is not terminated

echo "done: $?"
