#!/bin/bash

# While read with IFS and sort
echo "b:2" > /tmp/088_data.txt
echo "a:1" >> /tmp/088_data.txt
echo "c:3" >> /tmp/088_data.txt
while IFS=: read -r name num; do
    echo "$num $name"
done < /tmp/088_data.txt | sort -n
rm -f /tmp/088_data.txt
