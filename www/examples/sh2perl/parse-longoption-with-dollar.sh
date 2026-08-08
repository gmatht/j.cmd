#!/bin/sh
# LongOption regex used to consume $ after =, breaking --x="${VAR}"
X="test"
if true; then
    echo --x="${X}" || X=0
fi
