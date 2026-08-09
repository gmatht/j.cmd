# t48_accum: accumulate a sum in a loop
# diagnostics: program prints its result to stdout
set s 0
for n in 1 2 3
    set s (math $s + $n)
end
echo $s
