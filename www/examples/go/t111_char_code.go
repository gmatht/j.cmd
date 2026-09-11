package main

import "fmt"

// t111_char_code: byte/char code semantics. Go bytes and runes ARE
// integers: `c >= 'a'` compares codes numerically (not lexicographic
// text), and `string(c)` over a byte is chr (not identity) — the
// lexer's identifier scan and punct text depend on both.
func isLower(c int) bool {
	return c >= 'a' && c <= 'z'
}

func main() {
	fmt.Println(isLower(112))
	fmt.Println(string(112))
	s := "aba"
	fmt.Println(s[0] == 'a')
}
