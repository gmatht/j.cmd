package main

import "fmt"

// t106_iife_closure: an immediately-invoked func literal as a statement
// (`func() { ... }()` — the deferred-cleanup family without defer).
// The private sub shares the store, so captures read/write outer vars;
// also pins `delete` on a named map (the alias-restore cleanup shape).
func main() {
	n := 0
	func() {
		n = 1
	}()
	fmt.Println(n)
	m := map[string]string{"a": "1", "b": "2"}
	delete(m, "a")
	fmt.Println(m["b"])
}
