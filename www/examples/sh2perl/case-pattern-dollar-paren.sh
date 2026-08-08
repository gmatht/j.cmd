#!/bin/sh
# Test: A case pattern containing $(...) where the ) that closes $()
# must NOT be mistaken for the case-clause terminator.
case "$prev" in
    $(echo "foo|bar") )
        echo "matched"
        ;;
esac
