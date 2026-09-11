// t89_to_lower: strings.ToLower over a VAR → the `${s,,}` param op
// (LowercaseAll — the core's `param(",," name)` shape, byte-identical
// to the shell lowering; the runtime folds to toLowerCase). Literals
// keep folding at emit time (t71).
// diagnostics: program prints its result to stdout
package main

import (
	"fmt"
	"strings"
)

func main() {
	s := "HeLLo"
	fmt.Println(strings.ToLower(s))
}
