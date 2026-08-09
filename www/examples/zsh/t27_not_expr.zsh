# t27_not_expr: logical negation
# diagnostics: program prints its result to stdout
x=""
if [[ ! -n $x ]]; then
    echo empty
fi
