# t80_arith_unary: unary minus/plus in math expressions (A1 Arith "Un" node)
# diagnostics: program prints its results to stdout
set x 5
set a (math -$x + 2)
echo $a
set c (math +7)
echo $c
