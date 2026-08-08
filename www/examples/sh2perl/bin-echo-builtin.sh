#!/bin/sh
# /bin/echo should not generate system('echo') which triggers check_qx
/bin/echo -e "hello world"

echo "exit: $?"
