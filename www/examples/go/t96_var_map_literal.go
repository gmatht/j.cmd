// t96_var_map_literal: `var m = map[K]V{...}` — the map literal in a
// var DECL (the cpp frontend's `var refuseKeywords = map[string]string{...}`
// whitelist tables). The type position `map[string]string` is consumed
// as tokens (never parsed as expressions — `string` inside `[string]`
// must not hit the string(x) conversion path), and bool values
// (`map[string]bool{...: true}`) are literals, not `$true` var reads.
// diagnostics: program prints its result to stdout
package main

import "fmt"

var refuse = map[string]string{
	"template": "templates",
	"class":    "classes",
}

var allowed = map[string]bool{
	"translation_unit": true,
	"comment":          true,
}

func main() {
	fmt.Println(refuse["template"])
	fmt.Println(allowed["comment"])
}
