#!/bin/sh
# This tests that look-behind regex is not used in pipeline_commands.rs
echo "hello" | tr 'h' 'H'

echo "exit: $?"
