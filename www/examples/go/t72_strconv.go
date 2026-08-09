// t72_strconv: Go strconv.Atoi + arithmetic
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (strconv package).
package main

import (
    "fmt"
    "strconv"
)

func main() {
    n, _ := strconv.Atoi("42")
    fmt.Println(n + 1)
}
