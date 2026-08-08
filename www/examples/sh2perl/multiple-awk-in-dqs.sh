#!/bin/sh
# DQS containing $() with nested single quotes, then another DQS
V1="$(grep VERSION /some/file | awk '{ print $1 }' | sed 's/"//g')"
if [ -z "$V1" ]; then
    if [ -f /etc/lsb-release ]; then
        case "$DISTRIB_ID" in
            Ubuntu)
                V2="$(dpkg -l somepkg | tail -1 | awk '{ print $3 }' | cut -f 1 -d -)"
                ;;
        esac
    fi
fi
echo "$V1 $V2"
