#!/bin/sh
# Regression test: '\'' escaping inside single-quoted strings.
# The sequence '\'' must not produce a lone SingleQuote token.
desc='text with '\''single quote'\'' inside'
echo "$desc"
