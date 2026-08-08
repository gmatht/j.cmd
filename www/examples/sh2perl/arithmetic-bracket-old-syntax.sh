# Demonstrate $[...] arithmetic expansion (deprecated bash syntax)
# Parser failed with: Unexpected token: ArithmeticBracket
i=0
i=$[$i+1]
j=$[$j+1]
echo $i $j
