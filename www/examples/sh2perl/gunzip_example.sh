#!/bin/bash
gunzip < /usr/share/man/uk/man1/w.1.gz > /tmp/w.1
echo "Decompressed man page"

echo "exit: $?"
