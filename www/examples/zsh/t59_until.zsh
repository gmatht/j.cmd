# t59_until: until loop (negated condition)
# diagnostics: program prints its result to stdout
i=0
until [ $i -ge 3 ]; do echo "u$i"; i=$((i+1)); done
