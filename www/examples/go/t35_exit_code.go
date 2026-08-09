// t35_exit_code: capture the exit code
// diagnostics: program prints its result to stdout
cmd := exec.Command("false")
err := cmd.Run()
if err != nil {
    fmt.Println("nonzero")
} else {
    fmt.Println("zero")
}
