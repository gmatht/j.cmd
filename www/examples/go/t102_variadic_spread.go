// t102_variadic_spread: variadic params (`parts ...string` — the tail
// positionals splice into a real array at function entry) and the
// variadic spread call f(args...) — the Spread ext node (ESTree
// SpreadElement; array-typed vars only).
// diagnostics: program prints its result to stdout
package main

import (
	"fmt"
	"strings"
)

func show(parts ...string) {
	fmt.Println(len(parts), parts[0])
	fmt.Println(strings.Join(parts, " "))
}

func main() {
	words := []string{"alpha", "beta", "gamma"}
	show(words...)
	show("solo")
}
