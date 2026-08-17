// t83_type_args: generic instantiation (grammar typeArgs —
// `Name[TypeList](args)` at a call site) — the subset accepts a
// top-level generic func decl (grammar typeParameters, `[T any]`) and
// lowers `id[int](5)` as a call carrying typeArgs:["int"] (A1 erasure
// contract, core request go-sh-typeargs: the deserializer validates the
// string array and drops it at ingress — no runtime form). Only
// type-INDEPENDENT generic bodies lower (here: identity — `return x`
// becomes `echo "$1"`), so erasure is faithful: native Go prints 5 via
// the instantiated generic, the transpiled side runs the sub.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func id[T any](x T) T { return x }

func main() {
	fmt.Println(id[int](5))
}
