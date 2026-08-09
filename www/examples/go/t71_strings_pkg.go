// t71_strings_pkg: Go strings package helpers
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (strings package methods).
package main

import (
    "fmt"
    "strings"
)

func main() {
    fmt.Println(strings.ToUpper("hello"))
    fmt.Println(strings.Contains("hello world", "world"))
}
