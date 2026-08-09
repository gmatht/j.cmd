// t36_read_stdin: read a line from stdin
// diagnostics: program prints its result to stdout
reader := bufio.NewReader(os.Stdin)
line, _ := reader.ReadString('\n')
fmt.Println("got", line)
