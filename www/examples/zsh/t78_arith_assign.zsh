# t78_arith_assign: zsh (( )) arithmetic assignment
# diagnostics: program prints its result to stdout
x=3
((x *= 2))
((x += 5))
echo $x
