#!/bin/bash
# Minimal reproduction of '}' unexpected after subshell
foo() {
    (
        echo hello
    )
    return 0
}

echo "exit: $?"
