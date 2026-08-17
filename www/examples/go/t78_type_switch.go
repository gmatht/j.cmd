// t78_type_switch: type switch — dispatch on the runtime type of an
// interface value (`switch v := x.(type)`; core request
// go-sh-20260813-154009 — the A1 type-dispatch facility: Case with a
// typeof discriminant lowers to sh2.typeOf, the guard var v binds to x)
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var x any = "hi"
	switch v := x.(type) {
	case int:
		fmt.Println("int", v)
	case string:
		fmt.Println("string", v)
	default:
		fmt.Println("other", v)
	}
}
