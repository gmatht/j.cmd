// t85_struct_type: struct type struct{ X int } (grammar structType) —
// the subset accepts a struct type in type position (here: as the
// return type of a func type in a var decl — same erasure path as
// t82/t84) and erases it (shell has no struct values); the value is
// never called or assigned to, only nil-checked. Composite literals
// and member access (s.X) are not lowered yet (frontend side of core
// request go-sh-structtype-20260814-054454, which gave the contract
// the dotted member-key shape).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var f func() struct{ X int } = nil
	if f == nil {
		fmt.Println("f is nil")
	}
}
