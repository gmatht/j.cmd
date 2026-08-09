# t41_local_var: local variable inside a function
# diagnostics: program prints its result to stdout
function f
    set -l y 5
    echo $y
end
f
