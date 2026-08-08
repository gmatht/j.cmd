#!/bin/sh
# Regression test: [[ -n $(cmd) ]] with command substitution inside
# double-bracket test. The ]] must be correctly recognized.
[[ -n $(echo "hello") ]] && echo "non-empty"
