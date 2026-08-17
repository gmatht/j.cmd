# t81_break: break exits the loop early (A1 Break node)
# diagnostics: program prints its result to stdout
i=0
while (( i < 5 )); do
    echo $i
    ((i++))
    if (( i == 3 )); then
        break
    fi
done
echo done
