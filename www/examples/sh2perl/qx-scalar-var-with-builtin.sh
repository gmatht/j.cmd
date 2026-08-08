#!/bin/sh
# Test: Generated Perl should use @_qx_cmd array, not $command scalar,
# to avoid check_qx.pl Pattern 2 (qx{$var} where var contains builtin).
result=$(sed -n '1p' /some/file)
echo "$result"
