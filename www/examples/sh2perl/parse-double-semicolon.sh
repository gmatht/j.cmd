#!/bin/sh
# Test: double semicolon ;; outside case context
# Some scripts use ;; in unusual positions
case "$1" in
    start)
        echo "starting"
        ;;
    stop)
        echo "stopping"
        ;;
esac
# This ;; at the end can be problematic for some parsers
echo "done" ;;
