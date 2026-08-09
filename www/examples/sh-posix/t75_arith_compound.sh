# t75_arith_compound: chained arithmetic assignment
# diagnostics: program prints its result to stdout
x=0
x=$((x + 2))
x=$((x * 3))
echo $x
echo $((2 ** 3))
