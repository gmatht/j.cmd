# t48_accum: accumulate a sum in a loop
# diagnostics: program prints its result to stdout
S=0
for n in 1 2 3; do
    S=$((S + n))
done
echo "$S"
