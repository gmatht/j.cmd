#!/bin/sh
# Case pattern with star and pipe
case "$arch" in
    i*86 | x86_64)
        cpu="$basic_machine"
        ;;
esac
printf "%s=[%s]\n" cpu "${cpu:-}"

