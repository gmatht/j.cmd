// t96_typed_params: function parameters whose types exercise the full
// skipType surface — slice []T, pointer *pkg.T, multi results — all
// erased under the A1 type-position contract; only the NAMES become
// $N params.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func total(nums []int) (int, error) {
	s := 0
	for i := 0; i < 3; i++ {
		s += i
	}
	return s, nil
}

func greet(name *string) string {
	return "hi"
}

func main() {
	s, _ := total(nil)
	fmt.Println(s)
	fmt.Println(greet(nil))
}
