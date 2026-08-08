#!/bin/sh
# Test: unexpected } (BraceClose) where parser doesn't expect it
# Some scripts have braces in comments or strings that confuse the parser
echo "hello"
}
# This } above is outside any block

echo "done: $?"
