#!/bin/bash
# Minimal reproduction of DoubleSemicolon / ParenClose in nested case statement
foo() {
    case $x in
        1) echo one ;;
        *) echo other ;;
    esac
}
