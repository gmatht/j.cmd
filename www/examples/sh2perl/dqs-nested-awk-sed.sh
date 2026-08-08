#!/bin/bash
# Demonstrates combined DQS/SQS nesting failure.  A double-quoted assignment
# with a $(...) containing both single-quoted awk and single-quoted sed with
# embedded double quotes triggers broken tokenization that cascades into
# subsequent shell code.
pretty_name="$(awk -F "=" '$1 ~ /PATTERN/ {print $2}' /dev/null | sed 's/"//g')"
for iface in $(cmd | awk '{print $1}')
do
  if [ -n "${iface}" ]; then
    ip="$(cmd | awk '{print$3}' | sed 's|\(.*\)/.*|\1|')"
printf 'pretty_name=[%s]\n' "$pretty_name"
    echo "${ip}"
  fi
done
