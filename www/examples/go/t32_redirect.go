// t32_redirect: redirect output to a file
// diagnostics: program prints its result to stdout
os.WriteFile("/tmp/f", []byte("data\n"), 0o644)
fmt.Println("wrote")
