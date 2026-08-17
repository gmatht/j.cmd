# t84_incdec: arithmetic increment/decrement (A1 arith IncDec)
# diagnostics: program prints its result to stdout
x=5
echo $(( x++ ))
echo $x
echo $(( ++x ))
echo $(( x-- ))
echo $(( --x ))
