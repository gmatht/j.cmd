package main

import "fmt"

// t107_spaced_return: multi-value returns whose values contain SPACES.
// The value channel is one capture stream, so slots join with the RS
// separator (\036) — a space join would shred "hello world" and shift
// every later slot (the golib's Shir JSON document needs this).
func pair() (string, string) {
	return "hello world", "foo bar"
}

func main() {
	a, b := pair()
	fmt.Println(a)
	fmt.Println(b)
}
