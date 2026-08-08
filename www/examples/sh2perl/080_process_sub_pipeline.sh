#!/bin/bash

echo a > /tmp/paste_a.txt
echo b > /tmp/paste_b.txt
paste /tmp/paste_a.txt /tmp/paste_b.txt
rm -f /tmp/paste_a.txt /tmp/paste_b.txt

echo "exit: $?"
