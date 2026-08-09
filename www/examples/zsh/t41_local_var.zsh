# t41_local_var: local variable inside a function
# diagnostics: program prints its result to stdout
f() {
    local y=5
    echo $y
}
f
