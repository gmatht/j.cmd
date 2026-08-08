#!/bin/sh
# chmod standalone - triggers system(chmod) or open3(chmod) without native handler
# Uses echo to avoid actually changing permissions
echo "chmod 600 myfile"

echo "exit: $?"
