# $@ inside $(...) within double-quoted string
readarray -t files <<<"$(
    for d in "$@"; do
        echo "$d"
    done
)"
