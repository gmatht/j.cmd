// t91_sprintf_varargs: fmt.Sprintf with a LITERAL format and VAR args →
// the command-substitution shape `$(printf FMT ARGS...)`
// (capture(Arrow[exec printf …])) — the value twin of the fmt.Printf
// statement path (t46 delegates the same format verbs to the runtime
// printf). Literal-only Sprintf folds at emit time (t74); a non-literal
// format (var format, variadics) stays refused.
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	n := 3
	s := fmt.Sprintf("%d-%s", n, "x")
	fmt.Println(s)
}
