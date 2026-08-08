#!/bin/sh
# Case pattern with bracket expression like -[CDFISUWXx])
case "$1" in
  -[CDFISUWXx]) echo "option";;
esac
