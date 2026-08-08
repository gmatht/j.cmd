#!/bin/sh
# Arithmetic with nested ${#arr[@]} and sub-expression
j=0
arr=(a b c)
j=$((j+(100/${#arr[@]})))
echo "$j"
printf "%s=[%s]\n" arr "${arr:-}"

