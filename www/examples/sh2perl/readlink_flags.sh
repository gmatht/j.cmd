#!/bin/bash
# Test readlink with various flags on actual symlinks
existing=$(readlink -e /usr/bin/vi)
missing=$(readlink -m /nonexistent/path)
full=$(readlink -f /usr/bin/python3)
echo "Existing: $existing"
echo "Missing:  $missing"
echo "Full:     $full"
