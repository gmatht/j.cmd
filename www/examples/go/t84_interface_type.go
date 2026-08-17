// t84_interface_type: interface type interface{} (grammar interfaceType)
// — the subset accepts interface{} in type position (here: as the return
// type of a func type in a var decl — same erasure path as t82) and
// erases it (shell has no interface values); the value is never called
// or assigned to, only nil-checked.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var f func() interface{} = nil
	if f == nil {
		fmt.Println("f is nil")
	}
}
