package main

import "fmt"

type tok struct {
	kind string
	text string
}

// t108_struct_slice_value: ranging a []tok VALUE slice (struct elements
// ride a list id, not shell items — the golib's own `toks, err :=
// lex(src)` shape). Covers single-target capture AND multi-target with
// a trailing error slot.
func mktoks() []tok {
	var out []tok
	out = append(out, tok{kind: "a", text: "x"})
	out = append(out, tok{kind: "b", text: "y"})
	return out
}

func mktoks2() ([]tok, error) {
	return mktoks(), nil
}

func main() {
	t1 := mktoks()
	for _, t := range t1 {
		fmt.Println(t.kind, t.text)
	}
	t2, _ := mktoks2()
	for _, t := range t2 {
		fmt.Println(t.kind, t.text)
	}
}
