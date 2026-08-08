#!/bin/sh
# Check_qx: generated qx{$var} where $var contains builtin 'echo'
greeting=$(echo "hello world")
echo "$greeting"
