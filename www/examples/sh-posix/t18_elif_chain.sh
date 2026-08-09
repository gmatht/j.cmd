# t18_elif_chain: if/elif chain
# diagnostics: program prints its result to stdout
X=3
if [ "$X" = "1" ]; then
    echo one
elif [ "$X" = "2" ]; then
    echo two
else
    echo many
fi
