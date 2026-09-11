// t87_continue: continue skips the rest of an iteration
// diagnostics: program prints its result to stdout
for i := 1; i <= 3; i++ {
    if i == 2 {
        continue
    }
    fmt.Println(i)
}
