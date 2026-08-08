#!/bin/sh
# Minimal repro: ${var-default} with plain '-' (no colon) must be recognized
# as a default-value parameter expansion, not as a literal variable name.
# Without the fix, '0640' would appear as '-0640' and trigger perlcritic
# "Integer with leading zeros".
MYVAR="${UMASK-0640}"
echo "$MYVAR"
