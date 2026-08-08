#!/bin/sh
# Minimal repro: heredoc followed by DQS with backtick containing '?' inside quotes
# The '?' inside the inner DQS within backtick command substitution must not
# be tokenized as a standalone Question token after heredoc re-tokenization.
myfunc()
{
cat << _EOF
Some heredoc content
_EOF
}

myvar="`grep -E "^Exec(\[[^]=]*])?=" /dev/null`"
echo "$myvar"
