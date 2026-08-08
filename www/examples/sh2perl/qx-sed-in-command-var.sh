#!/bin/sh
# Command stored in variable and run via backticks/qx, containing sed
# check_qx violation: sed is a builtin used via qx{$var}
result=`sed -n 's/foo/bar/p' < /dev/null`
echo "$result"
