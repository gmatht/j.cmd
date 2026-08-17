// t80_pointer_type: pointer type *T (grammar pointerType) — the subset
// accepts *T in type position (here: a var decl) and erases it (shell
// has no pointers); the value is never dereferenced, only nil-checked
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var p *int = nil
	if p == nil {
		fmt.Println("p is nil")
	}
}
