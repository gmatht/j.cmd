#!/bin/bash
# Parameter expansion error: incomplete ${...} across multiple lines
x="${foo:-bar
baz}"
echo "$x"
