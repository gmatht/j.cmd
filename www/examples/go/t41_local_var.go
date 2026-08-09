// t41_local_var: local variable inside a function
// diagnostics: program prints its result to stdout
f := func() {
    y := 5
    fmt.Println(y)
}
f()
