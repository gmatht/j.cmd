#!/bin/sh
# Echo with escaped backtick inside double quotes
echo "Invalid configuration \`$1\': more than four components" >&2
exit 1
