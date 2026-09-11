// t101_addr_deref: address-of &x and dereference *p — the AddressOf/
// Deref ext-node pair (snapshot semantics on the value-only JS backend:
// reads pass through; writes through a pointer refuse loudly).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	x := "hello"
	p := &x
	fmt.Println(*p)
	if p != nil {
		fmt.Println("non-nil")
	}
	y := "world"
	q := &y
	fmt.Println(*q)
}
