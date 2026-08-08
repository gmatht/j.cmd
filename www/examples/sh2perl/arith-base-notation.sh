#!/bin/bash
# Regression test: ((10#x > 5)) inside a function body
f() {
    ((10#x > 5))
}
printf "parsed OK\\n"

echo "exit: $?"
