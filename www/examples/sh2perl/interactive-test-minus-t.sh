#!/bin/sh
# -t test operator - Perl::Critic flags this as requiring IO::Interactive
if test -t 1; then
    echo "stdout is a terminal"
fi

echo "exit: $?"
