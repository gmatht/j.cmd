#!/bin/bash
# readlink canonicalizes symlinks to their real target
target=$(readlink -f /usr/bin/vi)
echo "vi resolves to: $target"
target2=$(readlink -f /usr/bin/python3)
echo "python3 resolves to: $target2"
