#!/bin/bash

# Sort order should be consistent regardless of locale
printf "c\na\nb\n" | sort

echo "exit: $?"
