#!/bin/sh
# egrep is not recognized as a native builtin, generates qx{}
# check_qx violation: egrep in qx{$command}
result=$(egrep "^pattern" /dev/null)
echo "$result"
