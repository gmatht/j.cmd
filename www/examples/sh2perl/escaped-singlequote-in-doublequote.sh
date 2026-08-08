#!/bin/sh
# Escaped single-quote inside double-quoted string
pkg=dummy
conffile=test
x="$(dpkg-query -W -f='${Conffiles}' "$pkg" | \
    sed -n -e "\' $conffile ' { s/ obsolete$//; s/.* //; p }")"
printf 'result=[%s]\n' "$x"
printf "%s=[%s]\n" pkg "${pkg:-}"
printf "%s=[%s]\n" conffile "${conffile:-}"

