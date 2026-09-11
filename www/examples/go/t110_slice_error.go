package main

import "fmt"

// t110_slice_error: a ([]string, error) multi-return — the FIRST slot is
// a scalar slice (space-joined items as segment 0 of the RS-joined
// capture), rebuilt into the array store (strSplit yields a list id;
// listItems unwraps to the spliced array). The trailing error slot binds
// empty (Go's dropped nil).
func getPair() ([]string, error) {
	return []string{"a", "b"}, nil
}

func main() {
	s, err := getPair()
	fmt.Println(len(s))
	fmt.Println(s[0], s[1])
	if err == nil {
		fmt.Println("noerr")
	}
}
