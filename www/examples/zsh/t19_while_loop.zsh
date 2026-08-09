# t19_while_loop: while loop with counter
# diagnostics: program prints its result to stdout
i=0
while (( i < 3 )); do
    echo $i
    ((i++))
done
