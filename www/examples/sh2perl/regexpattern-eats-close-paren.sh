#!/bin/bash
# Regression test: RegexPattern token (`^...`) inside $() inside [[ ]]
# should NOT consume the closing `)` as part of the regex pattern,
# otherwise the $() command substitution is never closed.
if [[ -z $(apt-cache --names-only search ^libssl) ]]; then
    echo "not found"
fi
