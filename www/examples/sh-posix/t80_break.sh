# t80_break: break out of a while loop early
# diagnostics: program prints its result to stdout
i=0
while [ "$i" -lt 3 ]; do
    echo "$i"
    i=$((i + 1))
    if [ "$i" -eq 2 ]; then
        break
    fi
done
