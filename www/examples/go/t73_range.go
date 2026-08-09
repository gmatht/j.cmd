// t73_range: Go range-over-int for loop
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
    sum := 0
    for i := range 4 {
        sum = sum + i
    }
    fmt.Println(sum)
}

// DRIVER: frontend emit gap (red gate — the worker's work item).
