#!/bin/bash

echo a > /tmp/while_test.txt
echo b >> /tmp/while_test.txt
while IFS= read -r line; do
    echo "Line: $line"
done < /tmp/while_test.txt
rm -f /tmp/while_test.txt
