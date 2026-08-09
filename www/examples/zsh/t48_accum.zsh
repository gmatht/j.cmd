# t48_accum: accumulate a sum in a loop
# diagnostics: program prints its result to stdout
s=0
for n in 1 2 3; do
    ((s += n))
done
echo $s
