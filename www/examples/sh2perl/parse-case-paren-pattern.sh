#!/bin/sh
case "$1" in
  (start) echo "starting" ;;
  (stop) echo "stopping" ;;
  (*) echo "unknown" ;;
esac
