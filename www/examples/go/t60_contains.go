// t60_contains: substring containment
// diagnostics: program prints its result to stdout
s := "hello world"
if strings.Contains(s, "world") {
    fmt.Println("has")
} else {
    fmt.Println("no")
}
if strings.Contains(s, "nope") {
    fmt.Println("has2")
} else {
    fmt.Println("no2")
}
