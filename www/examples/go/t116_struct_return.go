package main

import "fmt"

type pair struct {
	a string
	b string
}

func mk2() pair {
	return pair{a: "x", b: "y"}
}

func mkptr() *pair {
	return &pair{a: "p", b: "q"}
}

func main() {
	p := mk2()
	fmt.Println(p.a, p.b)
	q := mkptr()
	fmt.Println(q.a, q.b)
}
