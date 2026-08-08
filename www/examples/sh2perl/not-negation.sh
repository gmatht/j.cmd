#!/bin/bash
# Pipeline negation with !
# This tests the '! cmd' syntax
if ! true; then
    echo "false"
fi
! grep -q foo /dev/null

echo "exit: $?"
