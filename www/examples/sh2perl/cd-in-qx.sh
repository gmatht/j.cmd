#!/bin/sh
# cd generates qx{} instead of using Perl's chdir
# check_qx violation: cd in qx{$command}
result=$(cd /tmp && pwd)
echo "$result"
