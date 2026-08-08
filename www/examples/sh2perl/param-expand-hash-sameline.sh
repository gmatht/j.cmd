#!/bin/bash
# Regression test: ${var#pattern} with ; then on same line
if [ ${MAXWAIT% *} -gt ${MAXWAIT#* } ]; then
    echo "same line"
fi
