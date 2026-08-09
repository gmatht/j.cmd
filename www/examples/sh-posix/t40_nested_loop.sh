# t40_nested_loop: nested loops
# diagnostics: program prints its result to stdout
i=1
while [ "$i" -le 2 ]; do
    j=1
    while [ "$j" -le 2 ]; do
        echo "$i$j"
        j=$((j + 1))
    done
    i=$((i + 1))
done
