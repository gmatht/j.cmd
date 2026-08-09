// t70_switch: Go switch statement
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
    x := 2
    switch x {
    case 1:
        fmt.Println("one")
    case 2:
        fmt.Println("two")
    default:
        fmt.Println("other")
    }
}
