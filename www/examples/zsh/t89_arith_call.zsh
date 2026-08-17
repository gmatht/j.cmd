# t89_arith_call: arithmetic call expressions — tree-sitter-zsh
# _arithmetic_call_expression (math functions called inside (( )) and
# $(( )): single-arg sqrt/int, multi-arg hypot/fmod). zsh evaluates
# these via zsh/mathfunc; the runner resolves the same names through
# JS Math (deterministic subset — no rand()).
# diagnostics: program prints its result to stdout
zmodload zsh/mathfunc
if (( sqrt(9) == 3 )); then
    echo root-ok
else
    echo root-bad
fi
(( hypot(3, 4) == 5 )) && echo hyp-ok
(( fmod(7, 3) == 1 )) && echo mod-ok
x=$(( int(3.7) ))
echo "int=$x"
echo "len=$(( int(9) ))"
