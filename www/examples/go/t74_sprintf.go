// t74_sprintf: Go fmt.Sprintf
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
    s := fmt.Sprintf("%d-%s", 3, "x")
    fmt.Println(s)
}

// DRIVER: frontend emit gap (red gate — the worker's work item).
