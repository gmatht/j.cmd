// c-sh-go CLI: C source -> A1 shIR JSON (thin wrapper around the clib
// library, which the combined busybox also dispatches through).
package main

import (
	"fmt"
	"os"

	clib "github.com/gmatht/sh2loop/frontends/c-sh-go"
)

func main() {
	args := os.Args[1:]
	var file string
	for _, a := range args {
		if a == "--shir" || a == "--raw" {
			continue
		}
		file = a
	}
	if file == "" {
		fmt.Fprintln(os.Stderr, "usage: c-sh-go --shir <file.c> [--raw]")
		os.Exit(2)
	}
	src, err := os.ReadFile(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	out, err := clib.Shir(string(src))
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	os.Stdout.Write(out)
	os.Stdout.Write([]byte{'\n'})
}
