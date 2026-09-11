// t92_interface_type_decl: a top-level EMPTY interface type decl
// `type Expr interface{}` (the app's AST-node declarations, e.g.
// posix-sh-go lowering.go) — compile-time only, erased under the
// type-position erasure contract (t80/t82/t84/t85: shell has no
// interface values). Non-empty interface bodies (method dispatch) and
// other type decls (structs) stay refused loudly.
// diagnostics: program prints its result to stdout
package main

import "fmt"

type Expr interface{}

func main() {
	fmt.Println("decl")
}
