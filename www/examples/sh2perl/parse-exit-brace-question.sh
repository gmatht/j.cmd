#!/bin/sh
# Test braced exit status variable ${?}
exit ${?}
printf "parsed OK\\n"
