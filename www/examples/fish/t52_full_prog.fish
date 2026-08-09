# t52_full_prog: full program combining constructs
# diagnostics: program prints its result to stdout
function greet
    echo hello $argv[1]
end
for n in a b
    greet $n
end
