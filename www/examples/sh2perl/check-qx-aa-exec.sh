#!/bin/sh
# Test: aa-exec should not trigger 'exec' builtin false positive in check_qx
if aa-exec --help >/dev/null 2>&1; then
    echo "aa-exec works"
fi

echo "exit: $?"
