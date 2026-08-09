#!/bin/sh
# control flow: if/elif/else, while, for
count=3
if [ "$count" -gt 2 ]; then
  echo "big"
elif [ "$count" -gt 1 ]; then
  echo "mid"
else
  echo "small"
fi
i=1
while [ "$i" -le 3 ]; do
  echo "i=$i"
  i=$((i+1))
done
for name in alice bob; do
  echo "hello $name"
done
