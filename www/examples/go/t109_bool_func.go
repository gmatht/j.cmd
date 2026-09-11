package main

import "fmt"

// t109_bool_func: user bool functions in conditions and display.
// Predicate bodies signal via exit status; conditions exec + test $?
// (ps4 `if isYes(x)` was always false); Println shows the verdict.
func isYes(s string) bool {
	return s == "y"
}

func main() {
	if isYes("y") {
		fmt.Println("yes")
	}
	if !isYes("n") {
		fmt.Println("not-n")
	}
	fmt.Println(isYes("y"))
}
