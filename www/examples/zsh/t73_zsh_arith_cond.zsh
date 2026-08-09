# t73_zsh_arith_cond: arithmetic condition (( )) in if
# diagnostics: program prints its result to stdout
x=5
if (( x > 3 )); then
    echo big
else
    echo small
fi
