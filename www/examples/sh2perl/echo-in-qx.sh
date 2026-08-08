#!/bin/sh
# echo generates qx{} instead of using Perl's print
# check_qx violation: echo in qx{$command}
result=$(echo "hello world")
echo "$result"
