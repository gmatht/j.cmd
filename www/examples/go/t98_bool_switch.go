// t98_bool_switch: the boolean switch `switch { case cond: ... }` — no
// discriminant (the cpp frontend's lexer dispatch). Lowered to the
// nested if-else chain; default is the final else. Also exercises the
// De Morgan `!(a && b)` guard and the `"$((i+1))" -lt "$n"` arithmetic
// comparison operand.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	c := ' '
	n := 5
	i := 0
	switch {
	case c == ' ' || c == '\t':
		fmt.Println("space")
	case c == '/' && i+1 < n && !(i == 0 && c == 'x'):
		fmt.Println("slash")
	default:
		fmt.Println("other")
	}
}
