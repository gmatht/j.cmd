// fish-sh-go CLI: fish source -> A1 shIR JSON (thin wrapper around the
// fishlib library, which the combined busybox also dispatches through).
package main

import (
	"fmt"
	"os"

	fishlib "github.com/gmatht/sh2loop/frontends/fish-sh-go"
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: fish-sh-go --shir <file.fish> [--raw]")
		os.Exit(2)
	}
	if args[0] != "--shir" || len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: fish-sh-go --shir <file.fish> [--raw]")
		os.Exit(2)
	}
	src, err := os.ReadFile(args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}
	out, err := fishlib.Shir(string(src))
	if err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(1)
	}
	os.Stdout.Write(out)
}
