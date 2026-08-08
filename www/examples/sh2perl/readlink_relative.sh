#!/bin/bash
# Test readlink with relative symlinks
relative=$(readlink -f /usr/bin/corepack)
echo "Corepack resolves to: $relative"
