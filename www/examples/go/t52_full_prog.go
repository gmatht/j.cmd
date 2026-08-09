// t52_full_prog: full program combining constructs
// diagnostics: program prints its result to stdout
greet := func(name string) string {
    return "hello " + name
}
names := []string{"a", "b"}
for _, n := range names {
    fmt.Println(greet(n))
}
