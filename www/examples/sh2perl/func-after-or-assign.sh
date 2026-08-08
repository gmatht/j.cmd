#!/bin/sh
# Tests function definition after || VAR=value pattern
[ -n "${VAR}" ] || VAR="default"
my_func() {
    echo "hello $VAR"
}
my_func
