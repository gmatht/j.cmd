// t53_param_default: environment default value
// diagnostics: program prints its result to stdout
x := os.Getenv("x")
if x == "" {
    x = "def"
}
fmt.Println("a=" + x)
x = "set"
fmt.Println("b=" + x)
