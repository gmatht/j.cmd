// t98_if_init: the generic if-init assignment `if x := expr; cond { }`
// — the init lowers as an ordinary assignment statement, only the COND
// gates the branch.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	if v := 7; v > 5 {
		fmt.Println("big")
	}
	n := 2
	if double := n * 2; double == 4 {
		fmt.Println("two")
	}
}
