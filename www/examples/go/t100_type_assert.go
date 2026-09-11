// t100_type_assert: x.(T) type assertion + comma-ok (`v, ok := x.(T)`)
// — the TypeAssert ext node (checked passthrough, kind = the sh2.typeOf
// vocabulary); the ok boolean is the frontend's typeof comparison,
// stored "true"/"false" and gated via `"$ok"="true"` in conditions.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	var v any = "production"
	s, ok := v.(string)
	fmt.Println(s, ok)
	n, ok2 := v.(int64)
	_ = n
	fmt.Println(ok2)
	if ok {
		fmt.Println("branch taken")
	}
	if !ok2 {
		fmt.Println("not an int")
	}
}
