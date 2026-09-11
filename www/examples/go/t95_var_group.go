// t95_var_group: `var ( … )` grouped declarations with erased types —
// each spec lowers to its own Assign (the type position erases under
// the A1 erasure contract). Values are assigned before use: the A1 has
// no typed zero values (an unassigned read yields "", not 0/false —
// see FRONTEND.md gaps).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var (
		count int
		label string
		ratio float64
		flag  bool
	)
	count = 3
	label = "items"
	ratio = 5
	flag = true
	fmt.Println(label, count)
	fmt.Println(ratio, flag)
}
