// t95_empty_array: the empty array literal `[]string{}` — the A1
// Array.elements must marshal to `[]`, never `null` (the core's
// deserializer rejects null elements).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	a := []string{}
	fmt.Println(len(a))
	a = append(a, "x")
	fmt.Println(len(a))
}
