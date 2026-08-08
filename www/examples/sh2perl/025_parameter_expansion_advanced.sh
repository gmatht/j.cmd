#!/usr/bin/env bash

# Advanced parameter expansion examples
set -euo pipefail

echo "== Advanced parameter expansion =="
path="/tmp/025_param_expansion_file.txt"
echo "${path##*/}"       # file.txt
echo "${path%/*}"        # /tmp
s2="abba"; echo "${s2//b/X}"  # aXXa
