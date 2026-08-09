// t42_global_mut: function mutates a global
// diagnostics: program prints its result to stdout
g := 0
f := func() {
    g = 1
}
f()
fmt.Println(g)
