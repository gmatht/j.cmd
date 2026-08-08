#!/bin/sh
# Complex pipe with subshells and redirects
result=$(
  (echo one; echo two) |
  (echo three; echo four)
)
echo "$result"
