// t57_strings_ops: TrimPrefix/HasPrefix (otranspiler's flag parsing)
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (method-style strings calls).
fmt.Println(strings.TrimPrefix("--target=go", "--target="))
fmt.Println(strings.HasPrefix("abc", "a"))
