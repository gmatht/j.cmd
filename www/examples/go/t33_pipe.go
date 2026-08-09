// t33_pipe: pipe between commands
// diagnostics: program prints its result to stdout
out, err := exec.Command("echo", "hello").Output()
if err == nil {
    fmt.Print(string(out))
}
