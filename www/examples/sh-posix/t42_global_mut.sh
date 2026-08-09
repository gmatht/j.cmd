# t42_global_mut: function mutates a global
# diagnostics: program prints its result to stdout
G=0
f() {
    G=1
}
f
echo "$G"
