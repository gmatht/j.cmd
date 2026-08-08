#!/bin/bash

# While loop with pipeline inside
echo "hello" > /tmp/084_test.txt
echo "world" >> /tmp/084_test.txt
while read -r word; do
    echo "$word" | tr a-z A-Z
done < /tmp/084_test.txt
rm -f /tmp/084_test.txt
