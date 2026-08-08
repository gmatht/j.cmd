#!/bin/sh
# Regression test: "cat -" reads from stdin; the generator must not
# emit qx{cat -} which triggers check_qx.pl (cat is a builtin).
cat - > /tmp/out.txt

echo "exit: $?"
rm -f /tmp/out.txt
