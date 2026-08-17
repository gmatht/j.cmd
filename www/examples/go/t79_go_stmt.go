// t79_go_stmt: the `go` statement (Go grammar goStmt: GO expression) —
// a goroutine launched with a func literal, the only form the subset
// accepts. Lowered to Background(Subshell(body)) + wait — the shell
// `( body ) & wait` shape. Native Go is racy (main can exit before the
// goroutine runs — t44 documents the deterministic Start/Wait idiom),
// so main keeps busy in a numeric loop while the goroutine prints; the
// transpiled side runs the same loop, so both print bg then the sum.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	go func() {
		fmt.Println("bg")
	}()
	s := 0
	for i := 0; i < 50000000; i++ {
		s += i
	}
	fmt.Println(s)
}
