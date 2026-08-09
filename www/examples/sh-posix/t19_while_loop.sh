# t19_while_loop: while loop with counter
# diagnostics: program prints its result to stdout
i=0
while [ "$i" -lt 3 ]; do
    echo "$i"
    i=$((i + 1))
done
