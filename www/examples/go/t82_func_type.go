// t82_func_type: function type func(...) T (grammar functionType) — the
// subset accepts func(...) ... in type position (here: a var decl) and
// erases it (shell has no first-class func values; only func literals
// lowered to subs, t22); the value is never called, only nil-checked.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var f func(int) int = nil
	if f == nil {
		fmt.Println("f is nil")
	}
}
