// t93_type_decls: top-level type declarations with composite underlying
// types — struct bodies (field lists, incl. func-typed fields) and
// non-empty interface method sets — plus `type (...)` groups. A type
// DECLARATION is compile-time only and has zero runtime statements, so
// the faithful drop-in lowering is ERASEMENT (parse the full body,
// emit nothing) under the same type-position erasure contract as the
// empty interface (t80/t82/t84/t85) and scalar aliases (t92).
// diagnostics: program prints its result to stdout
package main

import "fmt"

type frontend struct {
	name string
	shir func(src string) ([]byte, error)
}

type Handler interface {
	Handle(x string) error
	Name() string
}

type (
	tokKind int
 alias   = string
)

func main() {
	fmt.Println("types erased")
}
