// t61_while_read: read-loop over stdin
// diagnostics: program prints its result to stdout
sc := bufio.NewScanner(os.Stdin)
for sc.Scan() {
    fmt.Println("line=" + sc.Text())
}
