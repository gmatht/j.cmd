package main

import "fmt"

type rec struct {
	keys []string
	vals []string
}

// t105_parallel_lists: index+value range over one member list with a
// computed index read of a parallel list (`for i, k := range e.keys`
// + `e.vals[i]` — the golib's own parseReturn/mapEmit shape).
func main() {
	r := &rec{keys: []string{"a", "b"}, vals: []string{"1", "2"}}
	for i, k := range r.keys {
		fmt.Println(k, r.vals[i])
	}
}
