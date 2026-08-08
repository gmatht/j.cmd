#!/bin/bash

# File manipulation commands with backticks
# This file demonstrates using backticks with file manipulation commands

echo "=== File Manipulation Commands ==="

echo "=== cp command ==="
# cp command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `cp
d=$(mktemp -d)
cd "$d" || exit 1
echo
echo "test content" > test_file.txt
cp_result=`cp test_file.txt test_file_copy.txt && echo "Copy successful"`
echo "Copy result: $cp_result"
ls test_file.txt test_file_copy.txt test_file_moved.txt 2>/dev/null || echo "No test files found"

echo
echo "=== mv command ==="
# mv command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `mv
mv_result=`mv test_file_copy.txt test_file_moved.txt && echo "Move successful"`
echo "Move result: $mv_result"
ls test_file.txt test_file_copy.txt test_file_moved.txt 2>/dev/null || echo "No test files found"

echo
echo "=== rm command ==="
# rm command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `rm
rm_result=`rm test_file.txt test_file_moved.txt && echo "Remove successful"`
echo "Remove result: $rm_result"
ls test_file.txt test_file_copy.txt test_file_moved.txt 2>/dev/null || echo "No test files found"

echo
echo "=== mkdir command ==="
# mkdir command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `mkdir
mkdir_result=`mkdir test_dir && echo "Directory created"`
echo "Mkdir result: $mkdir_result"
touch test_dir/file
ls test_dir 2>/dev/null || echo "Directory not found"
rm test_dir/file
rmdir test_dir

echo
echo "=== touch command ==="
# touch command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `touch
touch_result=`touch test_file.txt && echo "File touched"`
echo "Touch result: $touch_result"

echo
# Cleanup
rm -f test_file.txt test_file_copy.txt test_file_moved.txt
rm -rf test_dir 2>/dev/null || true
cd /
rm -rf "$d"

