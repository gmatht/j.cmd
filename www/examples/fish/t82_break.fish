# t82_break: break halts the innermost loop early
# diagnostics: program prints its result to stdout
set i 0
while test $i -lt 5
    set i (math $i + 1)
    if test $i -eq 3
        break
    end
    echo "iter $i"
end
echo "after $i"
