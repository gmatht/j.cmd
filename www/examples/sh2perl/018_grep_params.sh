#!/bin/bash

# Grep parameters and options examples
# Demonstrates various grep command line parameters

echo "== Basic grep parameters =="
echo "text with pattern" | grep -i "PATTERN" && echo "  -i match: OK" || echo "  -i match: FAIL"

count=$(echo -e "line1\nline2\nline3" | grep -v "line2" | wc -l)
echo "  -v count: $count (expected 2)"

matched=$(echo -e "match\nno match\nmatch again" | grep -c "match")
echo "  -c count: $matched (expected 2)"

echo "== Context parameters =="
echo -e "line1\nline2\nTARGET\nline4\nline5" | grep -A 2 "TARGET" > /tmp/grep_out.txt
echo "  -A 2 lines: $(wc -l < /tmp/grep_out.txt) (expected 3)"

echo -e "line1\nline2\nTARGET\nline4\nline5" | grep -B 2 "TARGET" > /tmp/grep_out.txt
echo "  -B 2 lines: $(wc -l < /tmp/grep_out.txt) (expected 3)"

echo -e "line1\nline2\nTARGET\nline4\nline5" | grep -C 1 "TARGET" > /tmp/grep_out.txt
echo "  -C 1 lines: $(wc -l < /tmp/grep_out.txt) (expected 3)"

echo "== File handling parameters =="
echo "content" > /tmp/grep_file.txt
grep -c "content" /tmp/grep_file.txt && echo "  -c file: OK" || echo "  -c file: FAIL"
grep -l "content" /tmp/grep_file.txt && echo "  -l: found" || echo "  -l: not found"
grep -L "nonexistent" /tmp/grep_file.txt && echo "  -L: not found (correct)" || echo "  -L: found (wrong)"

echo "== Output formatting parameters =="
matched=$(echo "text with pattern in it" | grep -o "pattern")
echo "  -o match: '$matched' (expected 'pattern')"

lineno=$(echo "text with pattern in it" | grep -n "pattern" | cut -d: -f1)
echo "  -n line: $lineno (expected 1)"

echo "== Recursive parameters =="
mkdir -p /tmp/grep_sub && echo "subfile content" > /tmp/grep_sub/file.txt
found=$(grep -r "subfile" /tmp/grep_sub 2>/dev/null | wc -l)
echo "  -r recursive: $found files matched (expected 1)"
rm -rf /tmp/grep_sub

echo "== Line length parameters =="
longline=$(printf 'a%.0s' {1..200})
echo "$longline" | grep -m 1 "a" > /dev/null && echo "  -m 1 (long line): OK" || echo "  -m 1 (long line): FAIL"

echo "== Word-regexp and line-regexp parameters =="
echo -e "foo\nfoobar\nbar" | grep -w "foo" > /tmp/grep_out.txt
echo "  -w word match lines: $(wc -l < /tmp/grep_out.txt) (expected 1)"

rm -f /tmp/grep_file.txt /tmp/grep_out.txt
