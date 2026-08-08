#!/bin/sh
# Minimal test: mv command with unknown option (-Z) triggers shell fallback.
# The generator used to produce qx{$mv_cmd}, now produces system $mv_cmd_str.
mv -Z src.txt dest.txt
