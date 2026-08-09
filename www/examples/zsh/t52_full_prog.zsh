# t52_full_prog: full program combining constructs
# diagnostics: program prints its result to stdout
greet() {
    echo "hello $1"
}
for n in a b; do
    greet "$n"
done
