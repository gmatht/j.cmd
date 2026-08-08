#!/bin/sh
# Test: standalone redirect (truncate file, no command) should parse.
>somefile
printf 'standalone redirect file size=%s\n' "$(stat -c%s somefile 2>/dev/null || wc -c < somefile)"
rm somefile
