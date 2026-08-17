# t82_continue: continue skips the rest of the current iteration (A1 Continue node)
# diagnostics: program prints its result to stdout
i=0
while (( i < 5 )); do
    ((i++))
    if (( i == 3 )); then
        continue
    fi
    echo $i
done
echo done
