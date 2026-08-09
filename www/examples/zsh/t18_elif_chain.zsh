# t18_elif_chain: if/elif chain
# diagnostics: program prints its result to stdout
x=3
if [[ $x == 1 ]]; then
    echo one
elif [[ $x == 2 ]]; then
    echo two
else
    echo many
fi
