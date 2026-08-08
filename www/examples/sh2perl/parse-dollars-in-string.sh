# $@ and $* inside double-quoted strings
for i in "$@"; do echo "$i"; done
for i in "$*"; do echo "$i"; done
