// t68_case_glob: pattern dispatch via if/else
// diagnostics: program prints its result to stdout
s := "hello"
if strings.HasPrefix(s, "h") {
    fmt.Println("star")
} else if strings.Contains(s, "l") || strings.Contains(s, "x") {
    fmt.Println("alt")
}
s = "axl"
if strings.HasPrefix(s, "h") {
    fmt.Println("star2")
} else if strings.Contains(s, "l") || strings.Contains(s, "x") {
    fmt.Println("alt2")
}
