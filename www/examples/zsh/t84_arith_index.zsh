# t84_arith_index: array element read inside arithmetic (A1 arith Index)
# diagnostics: program prints its result to stdout
a=(10 20 30)
echo $(( a[-1] + 1 ))
echo $(( a[-2] * 2 ))
