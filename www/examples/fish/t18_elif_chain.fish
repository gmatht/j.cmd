# t18_elif_chain: if/elif chain
# diagnostics: program prints its result to stdout
set x 3
if test $x = 1
    echo one
else if test $x = 2
    echo two
else
    echo many
end
