# t59_until: negated-condition loop (fish has no until)
# diagnostics: program prints its result to stdout
set i 0
while not test $i -ge 3
    echo "u"$i
    set i (math $i + 1)
end
