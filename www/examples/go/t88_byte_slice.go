// t88_byte_slice: []byte(x) conversion — identity (strings ARE bytes in
// the A1; the A1 has no byte type, so the conversion is a parse-level
// no-op, mirroring the string(x) arm). Byte-slice COMPOSITE literals
// ([]byte{...}) stay REFUSED: an escaped char element ('\n') would
// silently lower as its raw two-char text (Refuse > guess).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	b := []byte("hi")
	fmt.Println(string(b))
}
