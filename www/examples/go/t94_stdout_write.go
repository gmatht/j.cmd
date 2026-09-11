// t94_stdout_write: os.Stdout.Write — the raw byte write WITHOUT the
// trailing newline echo adds (lowered to `printf "%s" "$x"`), both the
// var form and the []byte{...} byte-slice literal form (the CLI's
// newline terminator).
// diagnostics: program prints its result to stdout
package main

import (
	"fmt"
	"os"
)

func main() {
	s := "hi"
	os.Stdout.Write([]byte("there"))
	os.Stdout.Write([]byte(s))
	os.Stdout.Write([]byte{'\n'})
	fmt.Println("done")
}
