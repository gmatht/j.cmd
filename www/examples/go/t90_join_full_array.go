// t90_join_full_array: strings.Join over a FULL array (not a slice) with
// a " " separator → the `${arr[@]}` join shape
// (join(param("slice", name, "@", ""))) — the runtime joins arrays with
// spaces, matching Go's space separator (t66 covers the slice form).
// diagnostics: program prints its result to stdout
package main

import (
	"fmt"
	"strings"
)

func main() {
	a := []string{"x", "y"}
	fmt.Println(strings.Join(a, " "))
}
