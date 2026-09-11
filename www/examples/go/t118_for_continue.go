package main

import "fmt"

func main() {
	s := ""
	for i := 0; i < 5; i++ {
		if i == 2 {
			continue
		}
		s += "x"
	}
	fmt.Println(len(s))
	n := 0
	for i := 10; i > 0; i-- {
		if i == 5 {
			continue
		}
		n++
	}
	fmt.Println(n)
}
