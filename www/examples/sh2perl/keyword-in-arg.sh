#!/bin/bash
# Keywords like 'if' appearing as command arguments
tmpf=$(mktemp /tmp/dd_test.XXXXXX)
dd if=/dev/zero of="$tmpf" bs=1k count=1 2>/dev/null
printf 'dd output file size=%s\n' "$(stat -c%s "$tmpf" 2>/dev/null || wc -c < "$tmpf")"
rm -f "$tmpf"
