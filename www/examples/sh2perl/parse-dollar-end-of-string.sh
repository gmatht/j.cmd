#!/bin/sh
# Test: trailing $ at end of string
# Parser must handle $ followed by end-of-quote or end-of-line
echo "hello$"
echo "world$"
dollar=$
echo "$dollar"
