#!/bin/sh
# Minimal test: which with an argument (like 'uname') which is a builtin.
# Generator must avoid qx{$which_cmd} being flagged by check_qx.
which uname
printf "parsed OK\\n"
