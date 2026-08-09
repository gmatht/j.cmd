# t27_not_expr: logical negation
# diagnostics: program prints its result to stdout
set x ""
if not test -n "$x"
    echo empty
end
