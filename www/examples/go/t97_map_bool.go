// t97_map_bool: bool-VALUED map literal (a membership table — the
// fleet's allowedKinds/syncBuiltins idiom). Go bools print as
// true/false via fmt, so the drop-in lowering stores their textual
// form as the assoc-array value — byte-faithful under the echo.
// Reads cover PRESENT keys only: an absent-key read yields "" in the
// A1 (no per-type zero defaults — see FRONTEND.md gaps), where Go
// would give false.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	allowed := map[string]bool{
		"cat":  true,
		"dog":  false,
		"fish": true,
	}
	fmt.Println(allowed["cat"])
	fmt.Println(allowed["dog"])
	fmt.Println(allowed["fish"])
}
