#!/bin/sh
# Tests function definition after [ ] || pattern
[ -n "${VAR}" ] || VAR="default"
my_func() {
    echo "hello"
}
my_func
