# t92_arith_parens: parenthesized arithmetic expression — tree-sitter-zsh
# parenthesized_expression node: parens grouping inside arithmetic
# ($(( )) expansion and (( )) statement). The parser carries the raw
# expression through; the executor applies C precedence to the grouped
# sub-expression.
# diagnostics: program prints its result to stdout
x=$(( (1 + 2) * 3 ))
echo $x
(( y = 10 * (2 + 3) ))
echo $y
