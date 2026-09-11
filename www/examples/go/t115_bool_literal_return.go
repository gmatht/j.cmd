package main

import "fmt"

func isYes(s string) bool {
	if s == "y" {
		return true
	}
	return false
}

func main() {
	fmt.Println(isYes("y"), isYes("n"))
	if isYes("y") {
		fmt.Println("cond-true")
	}
	if isYes("n") {
		fmt.Println("cond-wrong")
	} else {
		fmt.Println("cond-false")
	}
}
