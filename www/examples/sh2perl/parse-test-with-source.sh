#!/bin/sh
# Test: source used in test expressions confusing the parser
var="hello"
if [ "source" = "$var" ]; then
    echo "source matched"
fi
. /etc/profile
printf "%s=[%s]\n" var "${var:-}"

