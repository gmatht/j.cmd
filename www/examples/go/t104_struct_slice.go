package main

import "fmt"

type tok struct {
	kind string
	text string
}

type line struct {
	toks []*tok
}

// t104_struct_slice: ranging a slice-of-struct field with member reads
// (the golib's own `for _, e := range rexprs` + `e.keys` shape):
// struct values construct via keyed &T{...} literals, the []*tok field
// rides a list ref, and the loop var binds the element struct type.
func main() {
	a := &tok{kind: "a", text: "x"}
	b := &tok{kind: "b", text: "y"}
	ln := &line{toks: []*tok{a, b}}
	for _, t := range ln.toks {
		fmt.Println(t.kind, t.text)
	}
}
