// t40_nested_loop: nested loops
// diagnostics: program prints its result to stdout
for i := 1; i <= 2; i++ {
    for j := 1; j <= 2; j++ {
        fmt.Println(i, j)
    }
}
