#!/bin/sh
# tail standalone - generates qx{$tail_cmd} which triggers QX violation
LAST_LINE=$(tail -1 /some/logfile)
echo "$LAST_LINE"
