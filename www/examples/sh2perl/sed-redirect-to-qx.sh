#!/bin/sh
# sed with input redirect generates qx{} which check_qx.pl flags
# check_qx violation: sed in qx{$command}
result=$(sed -n 's/foo/bar/p' < /dev/null)
echo "$result"
