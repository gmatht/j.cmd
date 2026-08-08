#!/bin/bash

# Basic cmp tests — compares two files byte by byte

# Setup: create test files with known content
echo "abcdefghij" > /tmp/cmp_a.txt
echo "abcdefghij" > /tmp/cmp_same.txt
echo "abcdeZghij" > /tmp/cmp_diff.txt     # differs at byte 6 (f vs Z)
echo "xyzdefghij" > /tmp/cmp_diff2.txt    # differs at byte 1 (a vs x)
echo "abc" > /tmp/cmp_short.txt
touch /tmp/cmp_empty.txt

# === Basic comparisons ===

# Identical files — exit 0, no output
cmp /tmp/cmp_a.txt /tmp/cmp_same.txt
echo "exit: $?"

# Different files — exit 1, reports first difference
cmp /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "exit: $?"

# Compare with empty file
cmp /tmp/cmp_a.txt /tmp/cmp_empty.txt
echo "exit: $?"

# Both empty
cmp /tmp/cmp_empty.txt /tmp/cmp_empty.txt
echo "exit: $?"

# === Flag: -s (silent, no output, only exit code) ===
cmp -s /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-s exit: $?"
cmp -s /tmp/cmp_a.txt /tmp/cmp_same.txt
echo "-s same exit: $?"

# === Flag: -l (verbose, print byte numbers and differing byte values) ===
cmp -l /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-l exit: $?"

# === Flag: -b (print differing bytes) ===
cmp -b /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-b exit: $?"

# === Flag: -n LIMIT (compare at most N bytes) ===
# Limit before the difference → files match
cmp -n 5 /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-n 5 exit: $?"
# Limit after the difference → files differ
cmp -n 10 /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-n 10 exit: $?"
# Limit with one shorter file
cmp -n 10 /tmp/cmp_a.txt /tmp/cmp_short.txt
echo "-n 10 short exit: $?"

# === Flag: -i SKIP (skip first N bytes of both files) ===
# Skip past the difference → files match
cmp -i 6 /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-i 6 exit: $?"
# Skip only part of the difference → still differ
cmp -i 3 /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-i 3 exit: $?"

# === Flag: -i SKIP1:SKIP2 (skip different amounts) ===
# Skip 0 from first, 6 from second (skip past diff in second)
cmp -i 0:6 /tmp/cmp_a.txt /tmp/cmp_diff.txt
echo "-i 0:6 exit: $?"
# Skip 5 from first, 0 from second
cmp -i 5:0 /tmp/cmp_a.txt /tmp/cmp_diff2.txt
echo "-i 5:0 exit: $?"

# === Process substitution (use -s to avoid non-deterministic /dev/fd/N paths) ===
cmp -s <(echo a) <(echo a)
echo "aa -s exit: $?"
cmp -s <(echo b) <(echo c)
echo "bc -s exit: $?"

# Cleanup
rm -f /tmp/cmp_a.txt /tmp/cmp_same.txt /tmp/cmp_diff.txt /tmp/cmp_diff2.txt /tmp/cmp_short.txt /tmp/cmp_empty.txt
