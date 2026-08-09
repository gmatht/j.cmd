// t50_file_test: test a file exists
// diagnostics: program prints its result to stdout
if _, err := os.Stat("/etc/passwd"); err == nil {
    fmt.Println("exists")
}
