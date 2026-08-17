// t81_channel_type: channel type chan T (grammar channelType) — the
// subset accepts chan T in type position (here: a var decl) and erases
// it (shell has no channels); sends/receives/select (sendStmt,
// recvStmt, selectStmt) stay refused, so the value is only nil-checked.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var ch chan int = nil
	if ch == nil {
		fmt.Println("ch is nil")
	}
}
