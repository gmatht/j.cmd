#!/bin/bash
# Regression test: double-quoted string with # (comment-like) inside
grep -w "#kernel.printk" /etc/sysctl.conf

echo "exit: $?"
