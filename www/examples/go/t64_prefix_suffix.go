// t64_prefix_suffix: prefix & suffix removal
// diagnostics: program prints its result to stdout
x := "hello"
fmt.Println(strings.TrimPrefix(x, "he"))
fmt.Println(strings.TrimSuffix(x, "lo"))
fmt.Println(x[strings.LastIndex(x, "l")+1:])
fmt.Println(x[:strings.Index(x, "l")])
