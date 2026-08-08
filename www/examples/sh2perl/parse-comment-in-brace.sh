#!/bin/sh
# Test: ${var#pattern} where `#` inside ${} should not eat `;;` case terminator
case "$opt" in
    "")
        ;;
    configfile=*)
        tmp=${opt#*=}
        ;;
    *)
        echo "default"
        ;;
esac
printf "%s=[%s]\n" tmp "${tmp:-}"
printf "%s=[%s]\n" configfile "${configfile:-}"

