#!/bin/sh
# Parse error: ${@:-"default"} parameter expansion
opts=${@:-"--help"}
echo "$opts"
