// go-sh CLI: Go source -> A1 shIR JSON (thin wrapper around the golib
// library, which the combined busybox also dispatches through).
package main

import (
	"fmt"
	"os"

	golib "github.com/gmatht/sh2loop/frontends/go-sh"
)

func main() {
	args := os.Args[1:]
	raw := false
	filtered := []string{}
	for _, a := range args {
		if a == "--raw" {
			raw = true
		} else {
			filtered = append(filtered, a)
		}
	}
	if len(filtered) != 2 || filtered[0] != "--shir" {
		fmt.Fprintln(os.Stderr, "usage: go-sh --shir <file.go> [--raw]")
		os.Exit(2)
	}
	inp := filtered[1]
	src := inp
	if b, err := os.ReadFile(inp); err == nil {
		src = string(b)
	}
	out, err := golib.Shir(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-sh: "+err.Error())
		os.Exit(2)
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
