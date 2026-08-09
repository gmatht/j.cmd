# t19_while_loop: while loop with counter
# diagnostics: program prints its result to stdout
set i 0
while test $i -lt 3
    echo $i
    set i (math $i + 1)
end
