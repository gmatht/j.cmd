#!/bin/sh
# Test: ${var-default} without colon (non-colon DefaultValue)
UMASK="${UMASK-0640}"
echo "$UMASK"
