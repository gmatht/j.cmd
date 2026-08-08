#!/bin/bash
# Various missing test operators in test expressions
if [ -h /dev/null ]; then true; fi
if [ -p /dev/null ]; then true; fi
if [ -b /dev/null ]; then true; fi
if [ -c /dev/null ]; then true; fi
if [ -g /dev/null ]; then true; fi
if [ -k /dev/null ]; then true; fi
if [ -u /dev/null ]; then true; fi
if [ -O /dev/null ]; then true; fi
if [ -G /dev/null ]; then true; fi
if [ -N /dev/null ]; then true; fi
# Comparative operators
if [ a -nt b ]; then true; fi
if [ a -ot b ]; then true; fi
if [ a -ef b ]; then true; fi
if [ -z "" ]; then true; fi
if [ -n "x" ]; then true; fi
printf "parsed OK\\n"

result="ok"
echo "status: ${result}"
