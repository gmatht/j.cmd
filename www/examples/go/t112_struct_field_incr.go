package main

import "fmt"

type rec struct {
	n int
	s string
}

func main() {
	r := &rec{n: 1, s: "a"}
	r.n++
	r.s = "b"
	r.n++
	fmt.Println(r.n, r.s)
}
