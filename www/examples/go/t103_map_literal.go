// t103_map_literal: map[K]V{…} composite literal in EXPRESSION position
// — the MapLiteral ext node (parallel keys/values), read back through
// the ElementRead node (computed coll[key]). A transient value: whole-
// dict assignment/return stays on the assocSet path or refuses.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	fmt.Println(map[string]string{"env": "prod", "tier": "web"}["tier"])
	m := map[string]string{"k": "v1"}
	_ = m
	fmt.Println("done")
}
