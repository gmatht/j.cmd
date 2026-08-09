# t27_not_expr: logical negation
# diagnostics: program prints its result to stdout
X=""
if [ ! -n "$X" ]; then
    echo empty
fi
