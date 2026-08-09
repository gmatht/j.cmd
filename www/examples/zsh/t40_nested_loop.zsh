# t40_nested_loop: nested loops
# diagnostics: program prints its result to stdout
for i in 1 2; do
    for j in 1 2; do
        echo $i$j
    done
done
