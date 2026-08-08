#!/bin/sh
# uname generates qx{} instead of using Perl's $^O
# check_qx violation: uname in qx{$command}
system=$(uname -s)
echo "$system"
