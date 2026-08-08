#!/bin/sh
# Test: LongOption regex must NOT eat the opening double-quote.
# --option="value" should tokenize as LongOption + Assign + DoubleQuotedString.
# Without the fix, the opening " is consumed by LongOption and the closing "
# becomes a spurious DoubleQuotedString that cascades across lines.
MYOPT="value"
echo "${MYOPT}"
