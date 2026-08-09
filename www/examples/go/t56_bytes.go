// t56_bytes: bytes.Buffer (otranspiler's output capture)
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (bytes).
var b bytes.Buffer
b.WriteString("hi")
fmt.Println(b.String())
