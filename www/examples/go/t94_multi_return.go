// t94_multi_return: multi-value return decl `(T, error)` on a func and
// a multi-value `return a, b` statement. The A1 lowers return to echo
// (a shell sub returns via stdout), so multiple result values map to
// multiple echo WORDS — the same channel a shell function uses to
// hand back several values. A captured call lowers as `q=$(f args)`
// (single non-_ target); printing a call runs the sub directly (its
// echo writes stdout).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func divmod(a int, b int) (int, error) {
	return a / b, nil
}

func swap(x string, y string) (string, string) {
	return y, x
}

func main() {
	q, _ := divmod(17, 5)
	fmt.Println(q)
	fmt.Println(swap("first", "second"))
}
