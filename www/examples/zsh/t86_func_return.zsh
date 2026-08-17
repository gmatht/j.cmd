# t86_func_return: return statement in a function (A1 Return)
# diagnostics: program prints its result to stdout
greet() {
    if [ -z "$1" ]; then
        return 1
    fi
    echo "hello $1"
    return 0
}
greet world
greet
echo done
