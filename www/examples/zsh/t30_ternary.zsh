# t30_ternary: conditional expression
# diagnostics: program prints its result to stdout
x=5
y=$((x > 0 ? 1 : 0))
echo $y
