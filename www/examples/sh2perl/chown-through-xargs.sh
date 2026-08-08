#!/bin/sh
# chown via xargs - generates open3() with builtin 'chown' as first arg
# Uses echo to avoid actually running
echo "/tmp/chown_through_xargs_test" | xargs -0 --no-run-if-empty echo chown -c root:root -- /tmp/chown_through_xargs_test

result="ok"
echo "status: ${result}"
