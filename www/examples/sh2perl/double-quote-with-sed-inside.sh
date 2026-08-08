#!/bin/sh
# DQS containing $() with nested single quotes containing " char
VERSION="$(grep VERSION_STR /some/file | awk '{ print $2 }' | sed 's/"//g')"
echo "$VERSION"
