#!/bin/sh
# cd in command substitution - generates open3 with builtin 'cd'
DIR=$(cd /some/dir && pwd)
echo "$DIR"
