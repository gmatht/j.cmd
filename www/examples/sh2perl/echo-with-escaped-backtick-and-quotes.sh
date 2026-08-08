#!/bin/sh
# Echo with escaped backtick and escaped single quote
echo "Invalid configuration \`"$1"\': more than four components" >&2
exit 1
