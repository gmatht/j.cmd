#!/bin/sh
# shellbench subshell — subshell + command substitution
x=$(echo "sub-result")
echo "cmdsub=$x"
( echo "group-run" )
