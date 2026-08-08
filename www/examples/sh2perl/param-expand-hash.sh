#!/bin/bash
# Regression test: ${var#pattern} inside a test expression
# The # inside ${} is a parameter-expansion operator, not a comment
if [ ${MAXWAIT% *} -gt ${MAXWAIT#* } ]; then
    echo "compare done"
fi
