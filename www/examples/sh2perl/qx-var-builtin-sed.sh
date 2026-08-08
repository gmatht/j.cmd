#!/bin/sh
# Check_qx: generated qx{$var} where $var contains builtin 'sed'
all_interfaces=$(sed -n 's/.*//p' < /dev/null)
echo "$all_interfaces"
