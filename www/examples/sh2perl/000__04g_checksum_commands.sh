#!/bin/bash

# Checksum commands using backticks
# This file demonstrates checksum and related commands with backticks

echo "=== Checksum Commands ==="

# sha256sum command with backticks
#PERL_MUST_NOT_CONTAIN `sha256sum
d=$(mktemp -d)
cd "$d" || exit 1
echo "test content" > test_checksum.txt
sha256_result=`sha256sum test_checksum.txt`
echo "SHA256 result: $sha256_result"

# sha512sum command with backticks
#PERL_MUST_NOT_CONTAIN `sha512sum
sha512_result=`sha512sum test_checksum.txt`
echo "SHA512 result: $sha512_result"

# strings command with backticks
#PERL_MUST_NOT_CONTAIN `strings
strings_result=`strings target/debug/debashc.exe | head -3`
echo "Strings result:"
echo "$strings_result"

# Cleanup
rm -f test_checksum.txt

echo "=== Checksum Commands Complete ==="
cd /
rm -rf "$d"

