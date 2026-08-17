# t78_arith_ternary: arithmetic ternary cond ? a : b (A1 arith Cond)
# diagnostics: program prints its result to stdout
echo $(( 1 > 0 ? 2 : 3 ))
echo $(( 0 > 1 ? 4 : 5 ))
