#!/bin/bash
# [[ ... ]] with || between multiple test expressions.
# The parser must handle [[ ]] as double-bracket tests and
# correctly process || operators between them.
if [[ -d /path1 ]] || [[ -d /path2 ]] || [[ -d /path3 ]]; then
    echo "found"
fi

result="ok"
echo "status: ${result}"
