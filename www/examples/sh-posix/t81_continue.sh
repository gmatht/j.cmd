# t81_continue: skip the rest of a loop iteration with continue
# diagnostics: program prints its result to stdout
i=0
while [ "$i" -lt 3 ]; do
    i=$((i + 1))
    if [ "$i" -eq 2 ]; then
        continue
    fi
    echo "$i"
done
