#!/bin/sh
# Case pattern with parentheses - config.sub style
arch=x86_64
basic_machine=pc
case "$arch" in
    i*86 | x86_64) cpu=$basic_machine ;;
    *) cpu=unknown ;;
esac
printf "%s=[%s]\n" cpu "${cpu:-}"
arch=arm64
case "$arch" in
    i*86 | x86_64) cpu=$basic_machine ;;
    *) cpu=unknown ;;
esac
printf "unknown: %s=[%s]\n" cpu "${cpu:-}"
