// t59_until: negated-condition loop (Go has no until)
// diagnostics: program prints its result to stdout
i := 0
for i < 3 {
    fmt.Printf("u%d\n", i)
    i++
}
