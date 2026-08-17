# t83_continue: continue skips the rest of the current loop iteration
# diagnostics: program prints its result to stdout
set i 0
while test $i -lt 5
    set i (math $i + 1)
    if test $i -eq 3
        continue
    end
    echo "iter $i"
end
echo "after $i"
