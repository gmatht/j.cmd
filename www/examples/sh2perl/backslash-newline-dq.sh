#!/bin/sh
# Demonstrate backslash-newline continuation inside double-quoted $() 
a="$(echo foo \
  || echo bar)"
echo "$a"
