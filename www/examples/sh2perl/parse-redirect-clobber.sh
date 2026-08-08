#!/bin/sh
# Test: >| (RedirectOutClobber) syntax
# Force truncate output file, ignoring set -C
set -C
tmpf=$(mktemp /tmp/clobber_test.XXXXXX)
: >| "$tmpf"
printf 'clobber file exists=%s\n' "$([ -f "$tmpf" ] && echo yes || echo no)"
rm -f "$tmpf"
